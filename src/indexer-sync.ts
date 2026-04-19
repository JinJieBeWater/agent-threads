import { Effect } from "effect";

import { CliFailure } from "./errors.ts";
import { fileExists, readFileStats, readFileString, readModifiedTime, removeFile, renamePath } from "./infra/fs.ts";
import { all, exec, get, withDatabase } from "./infra/sqlite.ts";
import {
  buildThreadRecordFromSessions,
  deleteThreadData,
  deleteTrackedSourcePath,
  deleteThreadSource,
  initializeIndexSchema,
  insertMessages,
  insertMessagesTableOnly,
  insertThread,
  insertThreads,
  isIndexUsable,
  readIndexedThreads,
  readTrackedSourceFiles,
  readTrackedThreadSources,
  refreshIndexMeta,
  refreshIndexMetaFromTrackedSources,
  rebuildMessagesFtsFromMessages,
  refreshSyncMeta,
  refreshThreadMetadataIfNeeded,
  resetIndex,
  touchThreadSourcesMetadata,
  trackedSourceNeedsRebuild,
  type SourceFileSnapshot,
  type IndexedThreadRow,
  type TrackedSourceFile,
  type TrackedThreadSource,
  upsertThreadSource,
  upsertThreadSources,
  markThreadSourceMissing,
} from "./indexer-store.ts";
import {
  hasTrustedHostManifest,
  readActiveThreadIdsSince,
  readLogsHighWater,
  inferThreadIdFromSessionFile,
  parseJsonlSession,
  readSourceFingerprint,
  readStateThreads,
  walkJsonlFiles,
} from "./source/codex.ts";
import type { MessageRecord, ParsedSessionFile, ResolvedPaths, ThreadRecord } from "./types.ts";

export interface RebuildIndexStats {
  builtAt: string;
  threadCount: number;
  messageCount: number;
  activeSessionFileCount: number;
  archivedSessionFileCount: number;
}

function sleepBeforePromotingShadowIndexForTest(): Effect.Effect<void> {
  const rawValue = process.env.ATH_TEST_INDEX_SWAP_BEFORE_PROMOTE_MS;
  const delayMs = rawValue ? Number(rawValue) : 0;
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Effect.void;
  }
  return Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
}

export function scanSourceFiles(paths: ResolvedPaths): Effect.Effect<SourceFileSnapshot[], CliFailure> {
  return Effect.gen(function* () {
    const activePaths = yield* walkJsonlFiles(paths.sessionsDir);
    const archivedPaths = yield* walkJsonlFiles(paths.archivedSessionsDir);
    const entries = [
      ...archivedPaths.map((path) => ({ path, archived: 1 as const })),
      ...activePaths.map((path) => ({ path, archived: 0 as const })),
    ];

    const snapshots = yield* Effect.forEach(
      entries,
      (entry) =>
        readFileStats(entry.path).pipe(
          Effect.map((stats) => ({
            path: entry.path,
            archived: entry.archived,
            sizeBytes: stats.sizeBytes,
            mtimeMs: Math.floor(stats.mtimeMs ?? 0),
          })),
        ),
      { concurrency: "unbounded" },
    );

    return snapshots.sort((left, right) => left.path.localeCompare(right.path));
  });
}

function parentDirectory(path: string): string | null {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return path.slice(0, slashIndex);
}

function collectSourceDirectories(paths: ResolvedPaths, snapshots: SourceFileSnapshot[]): string[] {
  const directories = new Set<string>([paths.sessionsDir, paths.archivedSessionsDir]);

  for (const snapshot of snapshots) {
    const root = snapshot.archived === 1 ? paths.archivedSessionsDir : paths.sessionsDir;
    let current = parentDirectory(snapshot.path);
    while (current?.startsWith(root)) {
      directories.add(current);
      if (current === root) {
        break;
      }
      current = parentDirectory(current);
    }
  }

  return [...directories].sort((left, right) => left.localeCompare(right));
}

function buildSourceDirectoryManifest(
  paths: ResolvedPaths,
  snapshots: SourceFileSnapshot[],
): Effect.Effect<string, CliFailure> {
  return Effect.gen(function* () {
    const directories = collectSourceDirectories(paths, snapshots);
    const entries = yield* Effect.forEach(
      directories,
      (path) =>
        readModifiedTime(path).pipe(
          Effect.map((mtimeMs) => ({
            path,
            mtimeMs: Math.floor(mtimeMs ?? 0),
          })),
        ),
      { concurrency: "unbounded" },
    );

    return JSON.stringify(entries);
  });
}

function hasMatchingSourceDirectoryManifest(
  storedManifest: string | undefined,
): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    if (!storedManifest) {
      return false;
    }

    let entries: Array<{ path: string; mtimeMs: number }>;
    try {
      entries = JSON.parse(storedManifest) as Array<{ path: string; mtimeMs: number }>;
    } catch {
      return false;
    }

    for (const entry of entries) {
      const currentMtime = yield* readModifiedTime(entry.path).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (Math.floor(currentMtime ?? 0) !== Number(entry.mtimeMs ?? 0)) {
        return false;
      }
    }

    return true;
  });
}

export function isSnapshotStableForRebuild(snapshot: SourceFileSnapshot): Effect.Effect<boolean, CliFailure> {
  return readFileString(snapshot.path).pipe(
    Effect.map((contents) => {
      const lines = contents.split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = (lines[index] ?? "").trim();
        if (line.length === 0) {
          continue;
        }
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }
      return contents.endsWith("\n");
    }),
  );
}

type SnapshotReadState =
  | {
      status: "stable";
      parsed: ParsedSessionFile | null;
      threadId: string | null;
    }
  | {
      status: "unstable";
      threadId: string | null;
    };

interface SnapshotStateReader {
  readSnapshotState: (snapshot: SourceFileSnapshot) => Effect.Effect<SnapshotReadState, CliFailure>;
  collectParsedSessionsForThread: (threadId: string) => Effect.Effect<ParsedSessionFile[], CliFailure>;
}

interface IncrementalSyncPlan {
  plannedRebuilds: Map<string, SourceFileSnapshot>;
  plannedMetadataRefreshes: Set<string>;
  plannedMissingMarks: Set<string>;
  plannedDeletes: Set<string>;
  plannedTrackedPathDeletes: Set<string>;
  blockedRebuildThreads: Set<string>;
}

function createParsedSnapshotReader(currentSnapshots: SourceFileSnapshot[]) {
  const snapshotStateCache = new Map<string, SnapshotReadState>();

  function readSnapshotState(snapshot: SourceFileSnapshot): Effect.Effect<SnapshotReadState, CliFailure> {
    return Effect.gen(function* () {
      if (snapshotStateCache.has(snapshot.path)) {
        return snapshotStateCache.get(snapshot.path) as SnapshotReadState;
      }
      const stable = yield* isSnapshotStableForRebuild(snapshot);
      if (!stable) {
        const threadId = yield* inferThreadIdFromSessionFile(snapshot.path).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        const state = {
          status: "unstable",
          threadId,
        } satisfies SnapshotReadState;
        snapshotStateCache.set(snapshot.path, state);
        return state;
      }
      const parsed = yield* parseJsonlSession(snapshot.path, snapshot.archived === 1);
      const state = {
        status: "stable",
        parsed,
        threadId: parsed?.threadId ?? null,
      } satisfies SnapshotReadState;
      snapshotStateCache.set(snapshot.path, state);
      return state;
    });
  }

  function collectParsedSessionsForThread(threadId: string): Effect.Effect<ParsedSessionFile[], CliFailure> {
    return Effect.gen(function* () {
      const sessions: ParsedSessionFile[] = [];
      for (const snapshot of currentSnapshots) {
        const snapshotState = yield* readSnapshotState(snapshot);
        if (snapshotState.status === "stable" && snapshotState.parsed?.threadId === threadId) {
          sessions.push(snapshotState.parsed);
        }
      }
      return sessions;
    });
  }

  return { readSnapshotState, collectParsedSessionsForThread };
}

function createIncrementalSyncPlan(): IncrementalSyncPlan {
  return {
    plannedRebuilds: new Map<string, SourceFileSnapshot>(),
    plannedMetadataRefreshes: new Set<string>(),
    plannedMissingMarks: new Set<string>(),
    plannedDeletes: new Set<string>(),
    plannedTrackedPathDeletes: new Set<string>(),
    blockedRebuildThreads: new Set<string>(),
  };
}

function finalizeIncrementalSyncPlan(plan: IncrementalSyncPlan): IncrementalSyncPlan {
  for (const threadId of plan.blockedRebuildThreads) {
    plan.plannedRebuilds.delete(threadId);
  }
  return plan;
}

function syncThreadSourcesForParsedSessions(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  threadId: string,
  parsedSessions: ParsedSessionFile[],
  snapshotByPath: Map<string, SourceFileSnapshot>,
  lastStateUpdatedAt: number,
  seenAt: string,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    yield* deleteThreadSource(db, threadId);
    for (const parsed of parsedSessions) {
      const sourceFile = parsed.meta.sourceFile;
      if (!sourceFile) {
        continue;
      }
      const snapshot = snapshotByPath.get(sourceFile);
      if (!snapshot) {
        continue;
      }
      yield* upsertThreadSource(db, threadId, snapshot, lastStateUpdatedAt, seenAt);
    }
  });
}

function groupTrackedSourceFilesByThread(trackedByPath: Map<string, TrackedSourceFile>): Map<string, TrackedSourceFile[]> {
  const grouped = new Map<string, TrackedSourceFile[]>();
  for (const tracked of trackedByPath.values()) {
    const rows = grouped.get(tracked.threadId) ?? [];
    rows.push(tracked);
    grouped.set(tracked.threadId, rows);
  }
  return grouped;
}

function chooseRepresentativeTrackedSource(
  trackedFiles: TrackedSourceFile[] | undefined,
  preferredPaths: Array<string | null | undefined> = [],
): TrackedThreadSource | undefined {
  if (!trackedFiles || trackedFiles.length === 0) {
    return undefined;
  }

  for (const preferredPath of preferredPaths) {
    if (!preferredPath) {
      continue;
    }
    const matched = trackedFiles.find((tracked) => tracked.currentPath === preferredPath);
    if (matched) {
      return matched;
    }
  }

  const sorted = [...trackedFiles].sort((left, right) => {
    const missingDelta = Number(left.missingSince !== null) - Number(right.missingSince !== null);
    if (missingDelta !== 0) {
      return missingDelta;
    }
    const archivedDelta = left.archived - right.archived;
    if (archivedDelta !== 0) {
      return archivedDelta;
    }
    return right.mtimeMs - left.mtimeMs;
  });
  return sorted[0];
}

function validateTrackedFiles(
  trackedFiles: TrackedSourceFile[],
): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    for (const tracked of trackedFiles) {
      const stats = yield* readFileStats(tracked.currentPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!stats) {
        return false;
      }

      if (
        trackedSourceNeedsRebuild(tracked, {
          path: tracked.currentPath,
          archived: tracked.archived,
          sizeBytes: stats.sizeBytes,
          mtimeMs: Math.floor(stats.mtimeMs ?? 0),
        })
      ) {
        return false;
      }
    }

    return true;
  });
}

function buildSnapshotFromPath(
  paths: ResolvedPaths,
  path: string,
): Effect.Effect<SourceFileSnapshot | null, CliFailure> {
  return readFileStats(path).pipe(
    Effect.map((stats) => ({
      path,
      archived: path.startsWith(paths.archivedSessionsDir) ? (1 as const) : (0 as const),
      sizeBytes: stats.sizeBytes,
      mtimeMs: Math.floor(stats.mtimeMs ?? 0),
    })),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

function buildTrustedThreadSnapshots(
  paths: ResolvedPaths,
  trackedFiles: TrackedSourceFile[] | undefined,
  stateThread: ThreadRecord | undefined,
): Effect.Effect<SourceFileSnapshot[] | null, CliFailure> {
  return Effect.gen(function* () {
    const candidatePaths = new Set<string>();
    for (const tracked of trackedFiles ?? []) {
      candidatePaths.add(tracked.currentPath);
    }
    if (stateThread?.rolloutPath) {
      candidatePaths.add(stateThread.rolloutPath);
    }
    if (candidatePaths.size === 0) {
      return null;
    }

    const snapshots: SourceFileSnapshot[] = [];
    for (const path of candidatePaths) {
      const snapshot = yield* buildSnapshotFromPath(paths, path);
      if (!snapshot) {
        return null;
      }
      snapshots.push(snapshot);
    }

    return snapshots.sort((left, right) => left.path.localeCompare(right.path));
  });
}

function hasTrackedFileChanges(
  trackedFiles: TrackedSourceFile[] | undefined,
  snapshots: SourceFileSnapshot[],
): boolean {
  if (!trackedFiles || trackedFiles.length !== snapshots.length) {
    return true;
  }

  const trackedByPath = new Map(trackedFiles.map((tracked) => [tracked.currentPath, tracked]));
  return snapshots.some((snapshot) => trackedSourceNeedsRebuild(trackedByPath.get(snapshot.path), snapshot));
}

export function synchronizeTrustedActiveThreadsUnlocked(paths: ResolvedPaths): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    const trustedManifest = yield* hasTrustedHostManifest(paths);
    if (!trustedManifest) {
      return false;
    }

    const sourceFingerprint = yield* readSourceFingerprint(paths);
    const logsHighWater = yield* readLogsHighWater(paths);
    const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const nowIso = new Date().toISOString();
    const stateThreads = yield* readStateThreads(paths.stateDb);

    if (sourceFingerprint === null || logsHighWater === null) {
      return false;
    }

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        const syncMeta = yield* all<{ key: string; value: string }>(db, `SELECT key, value FROM sync_meta`).pipe(
          Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
        );
        if (syncMeta.last_source_fingerprint !== sourceFingerprint) {
          return false;
        }
        if (Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0)) {
          return false;
        }

        const previousLogsHighWater = Number(syncMeta.last_logs_high_water ?? 0);
        const currentLogsHighWater = Number(logsHighWater ?? 0);
        if (!Number.isFinite(currentLogsHighWater)) {
          return false;
        }
        if (currentLogsHighWater <= previousLogsHighWater) {
          return true;
        }

        const activeThreadIds = yield* readActiveThreadIdsSince(paths, previousLogsHighWater);
        if (activeThreadIds.length === 0) {
          yield* refreshSyncMeta(
            db,
            stateDbMtime,
            sourceFingerprint,
            syncMeta.last_source_directory_manifest ?? "",
            currentLogsHighWater,
            nowIso,
          );
          return true;
        }

        const trackedSourceFiles = yield* readTrackedSourceFiles(db);
        const trackedSourceFilesByThread = groupTrackedSourceFilesByThread(trackedSourceFiles);
        const trackedByThread = yield* readTrackedThreadSources(db);
        const indexedThreads = yield* readIndexedThreads(db);
        const selectivePlan = createIncrementalSyncPlan();
        const snapshotByPath = new Map<string, SourceFileSnapshot>();
        const parsedSessionsByThread = new Map<string, ParsedSessionFile[]>();
        let canAdvanceLogsHighWater = true;

        for (const threadId of activeThreadIds) {
          const trackedFiles = trackedSourceFilesByThread.get(threadId);
          const stateThread = stateThreads.get(threadId);
          const snapshots = yield* buildTrustedThreadSnapshots(paths, trackedFiles, stateThread);
          if (!snapshots) {
            return false;
          }

          for (const snapshot of snapshots) {
            snapshotByPath.set(snapshot.path, snapshot);
          }

          let parsedSessions: ParsedSessionFile[] = [];
          for (const snapshot of snapshots) {
            const stable = yield* isSnapshotStableForRebuild(snapshot);
            if (!stable) {
              canAdvanceLogsHighWater = false;
              parsedSessions = [];
              break;
            }
            const parsed = yield* parseJsonlSession(snapshot.path, snapshot.archived === 1);
            if (parsed?.threadId === threadId) {
              parsedSessions.push(parsed);
            }
          }

          if (parsedSessions.length === 0 && canAdvanceLogsHighWater === false) {
            continue;
          }
          if (parsedSessions.length === 0) {
            return false;
          }

          parsedSessions = parsedSessions.sort((left, right) =>
            String(left.meta.sourceFile ?? "").localeCompare(String(right.meta.sourceFile ?? "")),
          );
          parsedSessionsByThread.set(threadId, parsedSessions);

          const tracked = trackedByThread.get(threadId);
          const needsRebuild = hasTrackedFileChanges(trackedFiles, snapshots);
          const needsMetadataRefresh =
            !!tracked && !!stateThread && tracked.lastStateUpdatedAt !== Number(stateThread.updatedAt ?? 0);

          if (!tracked || needsRebuild) {
            const firstSnapshot = snapshots[0];
            if (!firstSnapshot) {
              return false;
            }
            selectivePlan.plannedRebuilds.set(threadId, firstSnapshot);
            continue;
          }

          if (needsMetadataRefresh) {
            selectivePlan.plannedMetadataRefreshes.add(threadId);
          }
        }

        if (
          selectivePlan.plannedRebuilds.size === 0 &&
          selectivePlan.plannedMetadataRefreshes.size === 0
        ) {
          if (canAdvanceLogsHighWater) {
            yield* refreshSyncMeta(
              db,
              stateDbMtime,
              sourceFingerprint,
              syncMeta.last_source_directory_manifest ?? "",
              currentLogsHighWater,
              nowIso,
            );
          }
          return true;
        }

        yield* db.withTransaction(
          Effect.gen(function* () {
            for (const [threadId] of selectivePlan.plannedRebuilds) {
              const parsedSessions = parsedSessionsByThread.get(threadId);
              if (!parsedSessions || parsedSessions.length === 0) {
                continue;
              }
              const { thread, canonicalMessages } = buildThreadRecordFromSessions(
                stateThreads.get(threadId),
                parsedSessions,
                snapshotByPath,
              );
              yield* deleteThreadData(db, threadId);
              yield* insertThread(db, thread);
              yield* insertMessages(db, canonicalMessages);
              yield* syncThreadSourcesForParsedSessions(
                db,
                threadId,
                parsedSessions,
                snapshotByPath,
                Number(stateThreads.get(threadId)?.updatedAt ?? 0),
                nowIso,
              );
            }

            for (const threadId of selectivePlan.plannedMetadataRefreshes) {
              const indexed = indexedThreads.get(threadId);
              const stateThread = stateThreads.get(threadId);
              const tracked = chooseRepresentativeTrackedSource(
                trackedSourceFilesByThread.get(threadId),
                [typeof indexed?.source_file === "string" ? indexed.source_file : null, stateThread?.rolloutPath],
              );
              if (!tracked || !indexed || !stateThread) {
                continue;
              }
              yield* refreshThreadMetadataIfNeeded(db, indexed, stateThread, tracked);
              yield* touchThreadSourcesMetadata(db, threadId, Number(stateThread.updatedAt ?? 0), nowIso);
            }

            yield* refreshSyncMeta(
              db,
              stateDbMtime,
              sourceFingerprint,
              syncMeta.last_source_directory_manifest ?? "",
              canAdvanceLogsHighWater ? currentLogsHighWater : previousLogsHighWater,
              nowIso,
            );
            yield* refreshIndexMetaFromTrackedSources(db, paths, nowIso);
          }),
        ).pipe(
          Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
        );

        return true;
      }),
    );
  });
}

function planStaleTrackedPaths(
  trackedByPath: Map<string, TrackedSourceFile>,
  currentByPath: Map<string, SourceFileSnapshot>,
  groupedTrackedByThread: Map<string, TrackedSourceFile[]>,
  stateThreads: Map<string, ThreadRecord>,
  plan: IncrementalSyncPlan,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const tracked of trackedByPath.values()) {
      if (currentByPath.has(tracked.currentPath)) {
        continue;
      }
      const siblings = groupedTrackedByThread.get(tracked.threadId) ?? [];
      const stillPresentSibling = siblings.some(
        (sibling) => sibling.currentPath !== tracked.currentPath && currentByPath.has(sibling.currentPath),
      );
      if (stillPresentSibling) {
        plan.plannedTrackedPathDeletes.add(tracked.currentPath);
        continue;
      }

      const stateThread = stateThreads.get(tracked.threadId);
      if (stateThread) {
        continue;
      }
      if (tracked.missingSince) {
        plan.plannedDeletes.add(tracked.threadId);
      } else {
        plan.plannedMissingMarks.add(tracked.threadId);
      }
    }
  });
}

function planStateThreads(
  stateThreads: Map<string, ThreadRecord>,
  trackedByThread: Map<string, TrackedThreadSource>,
  currentByPath: Map<string, SourceFileSnapshot>,
  reader: SnapshotStateReader,
  plan: IncrementalSyncPlan,
  coveredPaths: Set<string>,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const [threadId, stateThread] of stateThreads) {
      const tracked = trackedByThread.get(threadId);
      const expectedPath = tracked?.currentPath ?? stateThread.rolloutPath ?? null;
      if (!expectedPath) {
        continue;
      }

      const snapshot = currentByPath.get(expectedPath);
      if (!snapshot) {
        if (tracked) {
          if (tracked.missingSince) {
            plan.plannedDeletes.add(threadId);
          } else {
            plan.plannedMissingMarks.add(threadId);
          }
        }
        continue;
      }

      coveredPaths.add(snapshot.path);

      const snapshotState = yield* reader.readSnapshotState(snapshot);
      if (snapshotState.status === "unstable") {
        plan.blockedRebuildThreads.add(threadId);
        continue;
      }

      if (!tracked) {
        plan.plannedRebuilds.set(threadId, snapshot);
        continue;
      }

      if (trackedSourceNeedsRebuild(tracked, snapshot)) {
        plan.plannedRebuilds.set(threadId, snapshot);
        continue;
      }

      if (tracked.lastStateUpdatedAt !== Number(stateThread.updatedAt ?? 0)) {
        plan.plannedMetadataRefreshes.add(threadId);
      }
    }
  });
}

function planTrackedThreadsWithoutState(
  stateThreads: Map<string, ThreadRecord>,
  trackedByThread: Map<string, TrackedThreadSource>,
  currentByPath: Map<string, SourceFileSnapshot>,
  reader: SnapshotStateReader,
  plan: IncrementalSyncPlan,
  coveredPaths: Set<string>,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const [threadId, tracked] of trackedByThread) {
      if (stateThreads.has(threadId)) {
        continue;
      }

      const snapshot = currentByPath.get(tracked.currentPath);
      if (snapshot) {
        coveredPaths.add(snapshot.path);
        const snapshotState = yield* reader.readSnapshotState(snapshot);
        if (snapshotState.status === "unstable") {
          plan.blockedRebuildThreads.add(threadId);
          continue;
        }
        if (trackedSourceNeedsRebuild(tracked, snapshot)) {
          plan.plannedRebuilds.set(threadId, snapshot);
        }
        continue;
      }

      if (tracked.missingSince) {
        plan.plannedDeletes.add(threadId);
      } else {
        plan.plannedMissingMarks.add(threadId);
      }
    }
  });
}

function planUncoveredSnapshots(
  currentSnapshots: SourceFileSnapshot[],
  coveredPaths: Set<string>,
  stateThreads: Map<string, ThreadRecord>,
  trackedByThread: Map<string, TrackedThreadSource>,
  currentByPath: Map<string, SourceFileSnapshot>,
  reader: SnapshotStateReader,
  plan: IncrementalSyncPlan,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const snapshot of currentSnapshots) {
      if (coveredPaths.has(snapshot.path)) {
        continue;
      }
      const snapshotState = yield* reader.readSnapshotState(snapshot);
      const discoveredThreadId = snapshotState.threadId;
      if (!discoveredThreadId) {
        continue;
      }
      const tracked = trackedByThread.get(discoveredThreadId);
      const stateThread = stateThreads.get(discoveredThreadId);
      const canonicalPath = tracked?.currentPath ?? stateThread?.rolloutPath ?? null;
      plan.plannedMissingMarks.delete(discoveredThreadId);
      plan.plannedDeletes.delete(discoveredThreadId);

      if (snapshotState.status === "unstable") {
        plan.blockedRebuildThreads.add(discoveredThreadId);
        continue;
      }

      if (!snapshotState.parsed || plan.plannedRebuilds.has(discoveredThreadId)) {
        continue;
      }

      plan.plannedRebuilds.set(
        discoveredThreadId,
        canonicalPath && currentByPath.has(canonicalPath) ? (currentByPath.get(canonicalPath) ?? snapshot) : snapshot,
      );
    }
  });
}

function applyIncrementalSyncPlan(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  input: {
    plan: IncrementalSyncPlan;
    reader: SnapshotStateReader;
    stateThreads: Map<string, ThreadRecord>;
    trackedByThread: Map<string, TrackedThreadSource>;
    trackedSourceFilesByThread: Map<string, TrackedSourceFile[]>;
    indexedThreads: Map<string, IndexedThreadRow>;
    currentByPath: Map<string, SourceFileSnapshot>;
    currentSnapshots: SourceFileSnapshot[];
    paths: ResolvedPaths;
    stateDbMtime: number | null;
    sourceFingerprint: string | null;
    sourceDirectoryManifest: string;
    logsHighWater: number | null;
    nowIso: string;
  },
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const { plan, reader, stateThreads, trackedByThread, trackedSourceFilesByThread, indexedThreads, currentByPath, currentSnapshots, paths, stateDbMtime, sourceFingerprint, sourceDirectoryManifest, logsHighWater, nowIso } =
      input;
    const touchedThreadData = plan.plannedRebuilds.size > 0 || plan.plannedDeletes.size > 0;
    let touchedThreadMetadata = false;

    yield* db.withTransaction(
      Effect.gen(function* () {
        for (const path of plan.plannedTrackedPathDeletes) {
          yield* deleteTrackedSourcePath(db, path);
        }

        for (const threadId of plan.plannedDeletes) {
          yield* deleteThreadData(db, threadId);
          yield* deleteThreadSource(db, threadId);
        }

        for (const [expectedThreadId, snapshot] of plan.plannedRebuilds) {
          const snapshotState = yield* reader.readSnapshotState(snapshot);
          if (snapshotState.status !== "stable" || !snapshotState.parsed) {
            continue;
          }

          if (expectedThreadId !== snapshotState.parsed.threadId) {
            yield* deleteThreadData(db, expectedThreadId);
            yield* deleteThreadSource(db, expectedThreadId);
          }

          const parsedSessions = yield* reader.collectParsedSessionsForThread(snapshotState.parsed.threadId);
          const { thread, canonicalMessages } = buildThreadRecordFromSessions(
            stateThreads.get(snapshotState.parsed.threadId),
            parsedSessions,
            currentByPath,
          );
          yield* deleteThreadData(db, snapshotState.parsed.threadId);
          yield* insertThread(db, thread);
          yield* insertMessages(db, canonicalMessages);
          yield* syncThreadSourcesForParsedSessions(
            db,
            snapshotState.parsed.threadId,
            parsedSessions,
            currentByPath,
            Number(stateThreads.get(snapshotState.parsed.threadId)?.updatedAt ?? 0),
            nowIso,
          );
        }

        for (const threadId of plan.plannedMetadataRefreshes) {
          const indexed = indexedThreads.get(threadId);
          const stateThread = stateThreads.get(threadId);
          const tracked = chooseRepresentativeTrackedSource(
            trackedSourceFilesByThread
              .get(threadId)
              ?.filter((sourceFile) => !plan.plannedTrackedPathDeletes.has(sourceFile.currentPath)),
            [typeof indexed?.source_file === "string" ? indexed.source_file : null, stateThread?.rolloutPath],
          );
          if (!tracked || !indexed || !stateThread) {
            continue;
          }
          const changed = yield* refreshThreadMetadataIfNeeded(db, indexed, stateThread, tracked);
          touchedThreadMetadata = touchedThreadMetadata || changed;
          yield* touchThreadSourcesMetadata(db, threadId, Number(stateThread.updatedAt ?? 0), nowIso);
        }

        for (const threadId of plan.plannedMissingMarks) {
          const tracked = trackedByThread.get(threadId);
          if (tracked) {
            yield* markThreadSourceMissing(db, tracked, nowIso);
          }
        }

        yield* refreshSyncMeta(db, stateDbMtime, sourceFingerprint, sourceDirectoryManifest, logsHighWater, nowIso);
        if (touchedThreadData || touchedThreadMetadata) {
          yield* refreshIndexMeta(db, paths, currentSnapshots, nowIso);
        }
      }),
    ).pipe(
      Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
    );
  });
}

export function synchronizeIncrementalUnlocked(paths: ResolvedPaths): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const nowIso = new Date().toISOString();
    const stateThreads = yield* readStateThreads(paths.stateDb);
    const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const sourceFingerprint = yield* readSourceFingerprint(paths);
    const logsHighWater = yield* readLogsHighWater(paths);
    const currentSnapshots = yield* scanSourceFiles(paths);
    const sourceDirectoryManifest = yield* buildSourceDirectoryManifest(paths, currentSnapshots);
    const currentByPath = new Map(currentSnapshots.map((snapshot) => [snapshot.path, snapshot]));
    const { readSnapshotState, collectParsedSessionsForThread } = createParsedSnapshotReader(currentSnapshots);

    yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        yield* initializeIndexSchema(db);

        const trackedSourceFiles = yield* readTrackedSourceFiles(db);
        const trackedSourceFilesByThread = groupTrackedSourceFilesByThread(trackedSourceFiles);
        const trackedByThread = yield* readTrackedThreadSources(db);
        const syncMeta = yield* all<{ key: string; value: string }>(db, `SELECT key, value FROM sync_meta`).pipe(
          Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
        );
        const indexedThreads: Map<string, IndexedThreadRow> =
          Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0)
            ? yield* readIndexedThreads(db)
            : new Map<string, IndexedThreadRow>();

        const plan = createIncrementalSyncPlan();
        const coveredPaths = new Set<string>();

        yield* planStateThreads(stateThreads, trackedByThread, currentByPath, { readSnapshotState, collectParsedSessionsForThread }, plan, coveredPaths);
        yield* planTrackedThreadsWithoutState(stateThreads, trackedByThread, currentByPath, { readSnapshotState, collectParsedSessionsForThread }, plan, coveredPaths);
        yield* planUncoveredSnapshots(
          currentSnapshots,
          coveredPaths,
          stateThreads,
          trackedByThread,
          currentByPath,
          { readSnapshotState, collectParsedSessionsForThread },
          plan,
        );
        yield* planStaleTrackedPaths(
          trackedSourceFiles,
          currentByPath,
          trackedSourceFilesByThread,
          stateThreads,
          plan,
        );
        finalizeIncrementalSyncPlan(plan);

        const shouldRefreshMetadata = Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0);
        const shouldRefreshFingerprint = (syncMeta.last_source_fingerprint ?? "") !== (sourceFingerprint ?? "");
        const shouldRefreshDirectoryManifest =
          (syncMeta.last_source_directory_manifest ?? "") !== sourceDirectoryManifest;
        const shouldWrite =
          plan.plannedRebuilds.size > 0 ||
          plan.plannedMetadataRefreshes.size > 0 ||
          plan.plannedMissingMarks.size > 0 ||
          plan.plannedDeletes.size > 0 ||
          plan.plannedTrackedPathDeletes.size > 0 ||
          shouldRefreshMetadata ||
          shouldRefreshFingerprint ||
          shouldRefreshDirectoryManifest;

        if (!shouldWrite) {
          return;
        }

        yield* applyIncrementalSyncPlan(db, {
          plan,
          reader: { readSnapshotState, collectParsedSessionsForThread },
          stateThreads,
          trackedByThread,
          trackedSourceFilesByThread,
          indexedThreads,
          currentByPath,
          currentSnapshots,
          paths,
          stateDbMtime,
          sourceFingerprint,
          sourceDirectoryManifest,
          logsHighWater,
          nowIso,
        });
      }),
    );
  });
}

export function canSkipIncrementalSync(paths: ResolvedPaths): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    const usable = yield* isIndexUsable(paths);
    if (!usable) {
      return false;
    }

    const sourceFingerprint = yield* readSourceFingerprint(paths);
    const logsHighWater = yield* readLogsHighWater(paths);

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        const trackedByPath = yield* readTrackedSourceFiles(db);
        const trackedByThread = groupTrackedSourceFilesByThread(trackedByPath);
        const syncMeta = yield* all<{ key: string; value: string }>(db, `SELECT key, value FROM sync_meta`).pipe(
          Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
        );

        if (Array.from(trackedByPath.values()).some((tracked) => tracked.missingSince !== null)) {
          return false;
        }

        if (sourceFingerprint !== null) {
          if (syncMeta.last_source_fingerprint !== sourceFingerprint) {
            return false;
          }

          const trustedManifest = yield* hasTrustedHostManifest(paths);
          if (!trustedManifest) {
            return false;
          }

          const previousLogsHighWater = Number(syncMeta.last_logs_high_water ?? 0);
          const currentLogsHighWater = Number(logsHighWater ?? 0);
          if (!Number.isFinite(currentLogsHighWater)) {
            return false;
          }

          if (currentLogsHighWater <= previousLogsHighWater) {
            return true;
          }

          const activeThreadIds = yield* readActiveThreadIdsSince(paths, previousLogsHighWater);
          for (const threadId of activeThreadIds) {
            const trackedFiles = trackedByThread.get(threadId);
            if (!trackedFiles || trackedFiles.length === 0) {
              return false;
            }
            if (!(yield* validateTrackedFiles(trackedFiles))) {
              return false;
            }
          }

          return true;
        }

        const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0)) {
          return false;
        }

        const liveTrackedByPath = new Map(
          Array.from(trackedByPath.entries()).filter(([, tracked]) => tracked.missingSince === null),
        );
        if (!(yield* hasMatchingSourceDirectoryManifest(syncMeta.last_source_directory_manifest))) {
          return false;
        }

        for (const [path, tracked] of liveTrackedByPath) {
          const stats = yield* readFileStats(path).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (!stats) {
            return false;
          }

          if (
            trackedSourceNeedsRebuild(tracked, {
              path,
              archived: tracked.archived,
              sizeBytes: stats.sizeBytes,
              mtimeMs: Math.floor(stats.mtimeMs ?? 0),
            })
          ) {
            return false;
          }
        }

        return true;
      }),
    );
  });
}

export function rebuildIndexUnlocked(
  paths: ResolvedPaths,
  strategy: "shadow-if-existing" | "in-place" = "shadow-if-existing",
): Effect.Effect<RebuildIndexStats, CliFailure> {
  return Effect.gen(function* () {
    const threadMap = yield* readStateThreads(paths.stateDb);
    const allSessions = yield* scanSourceFiles(paths);
    const snapshotByPath = new Map(allSessions.map((snapshot) => [snapshot.path, snapshot]));
    const sourceFingerprint = yield* readSourceFingerprint(paths);
    const logsHighWater = yield* readLogsHighWater(paths);
    const sourceDirectoryManifest = yield* buildSourceDirectoryManifest(paths, allSessions);
    const parsedSessionsByThread = new Map<string, ParsedSessionFile[]>();
    const existingMainIndex = yield* fileExists(paths.indexDb).pipe(Effect.catchAll(() => Effect.succeed(false)));

    const parsedSessions = yield* Effect.forEach(
      allSessions,
      (entry) => parseJsonlSession(entry.path, entry.archived === 1),
      { concurrency: 32 },
    );

    for (const parsed of parsedSessions) {
      if (!parsed) {
        continue;
      }
      const grouped = parsedSessionsByThread.get(parsed.threadId) ?? [];
      grouped.push(parsed);
      parsedSessionsByThread.set(parsed.threadId, grouped);
    }

    const canonicalThreadMessages = new Map<string, MessageRecord[]>();
    for (const [threadId, sessions] of parsedSessionsByThread) {
      const { thread, canonicalMessages } = buildThreadRecordFromSessions(
        threadMap.get(threadId),
        sessions,
        snapshotByPath,
      );
      threadMap.set(threadId, thread);
      canonicalThreadMessages.set(threadId, canonicalMessages);
    }

    function buildIndexAt(targetPaths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
      return withDatabase(targetPaths.indexDb, (db) =>
        Effect.gen(function* () {
          yield* initializeIndexSchema(db);

          const builtAt = new Date().toISOString();

          yield* db.withTransaction(
            Effect.gen(function* () {
              yield* resetIndex(db);

              yield* insertThreads(db, Array.from(threadMap.values()));

              for (const messages of canonicalThreadMessages.values()) {
                yield* insertMessagesTableOnly(db, messages);
              }
              yield* rebuildMessagesFtsFromMessages(db);

              const trackedSourceRows = Array.from(parsedSessionsByThread.entries()).flatMap(([threadId, parsed]) =>
                parsed.flatMap((session) => {
                  const sourceFile = session.meta.sourceFile;
                  if (!sourceFile) {
                    return [];
                  }
                  const snapshot = snapshotByPath.get(sourceFile);
                  if (!snapshot) {
                    return [];
                  }
                  return [
                    {
                      threadId,
                      snapshot,
                      lastStateUpdatedAt: Number(threadMap.get(threadId)?.updatedAt ?? 0),
                      seenAt: builtAt,
                    },
                  ];
                }),
              );
              yield* upsertThreadSources(db, trackedSourceRows);

              yield* refreshIndexMeta(db, targetPaths, allSessions, builtAt);
              const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
              yield* refreshSyncMeta(db, stateDbMtime, sourceFingerprint, sourceDirectoryManifest, logsHighWater, builtAt);
            }),
          ).pipe(
            Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
          );

          yield* exec(db, "PRAGMA wal_checkpoint(TRUNCATE)");

          const totals = yield* get<Record<string, unknown>>(
            db,
            `
              SELECT
                COUNT(*) AS thread_count,
                COALESCE(SUM(message_count), 0) AS message_count
              FROM threads
            `,
          ).pipe(
            Effect.map((row) => ({
              threadCount: Number(row?.thread_count ?? 0),
              messageCount: Number(row?.message_count ?? 0),
            })),
          );

          return {
            builtAt,
            threadCount: totals.threadCount,
            messageCount: totals.messageCount,
            activeSessionFileCount: allSessions.filter((snapshot) => snapshot.archived === 0).length,
            archivedSessionFileCount: allSessions.filter((snapshot) => snapshot.archived === 1).length,
          } satisfies RebuildIndexStats;
        }),
      );
    }

    if (strategy === "in-place" || !existingMainIndex) {
      return yield* buildIndexAt(paths);
    }

    const shadowIndexDb = `${paths.indexDb}.next-${process.pid}-${Date.now()}`;
    const shadowPaths = {
      ...paths,
      indexDb: shadowIndexDb,
    } satisfies ResolvedPaths;

    const cleanupPaths = [
      shadowIndexDb,
      `${shadowIndexDb}-wal`,
      `${shadowIndexDb}-shm`,
    ];

    return yield* Effect.acquireUseRelease(
      Effect.succeed(shadowPaths),
      (preparedPaths) =>
        Effect.gen(function* () {
          const stats = yield* buildIndexAt(preparedPaths);

          yield* removeFile(`${preparedPaths.indexDb}-wal`).pipe(Effect.catchAll(() => Effect.void));
          yield* removeFile(`${preparedPaths.indexDb}-shm`).pipe(Effect.catchAll(() => Effect.void));

          yield* sleepBeforePromotingShadowIndexForTest();
          yield* renamePath(preparedPaths.indexDb, paths.indexDb);

          // Readers can keep using the pre-swap file handle while the path now resolves to the rebuilt index.
          yield* removeFile(`${paths.indexDb}-wal`).pipe(Effect.catchAll(() => Effect.void));
          yield* removeFile(`${paths.indexDb}-shm`).pipe(Effect.catchAll(() => Effect.void));

          return stats;
        }),
      () =>
        Effect.forEach(cleanupPaths, (path) => removeFile(path).pipe(Effect.catchAll(() => Effect.void)), {
          concurrency: "unbounded",
          discard: true,
        }),
    );
  });
}
