import { Effect } from "effect";

import { CliFailure } from "./errors.ts";
import { readFileStats, readFileString, readModifiedTime } from "./infra/fs.ts";
import { all, get, withDatabase } from "./infra/sqlite.ts";
import {
  buildThreadRecordFromSessions,
  chooseCanonicalSnapshot,
  deleteThreadData,
  deleteThreadSource,
  initializeIndexSchema,
  insertMessages,
  insertThread,
  isIndexUsable,
  readIndexedThreads,
  readTrackedThreadSources,
  refreshIndexMeta,
  refreshSyncMeta,
  refreshThreadMetadataIfNeeded,
  resetIndex,
  trackedSourceNeedsRebuild,
  type SourceFileSnapshot,
  type IndexedThreadRow,
  type TrackedThreadSource,
  upsertThreadSource,
  markThreadSourceMissing,
} from "./indexer-store.ts";
import { inferThreadIdFromSessionFile, parseJsonlSession, readStateThreads, walkJsonlFiles } from "./source/codex.ts";
import type { MessageRecord, ParsedSessionFile, ResolvedPaths, ThreadRecord } from "./types.ts";

export interface RebuildIndexStats {
  builtAt: string;
  threadCount: number;
  messageCount: number;
  activeSessionFileCount: number;
  archivedSessionFileCount: number;
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
            mtimeMs: stats.mtimeMs ?? 0,
          })),
        ),
      { concurrency: "unbounded" },
    );

    return snapshots.sort((left, right) => left.path.localeCompare(right.path));
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
    blockedRebuildThreads: new Set<string>(),
  };
}

function finalizeIncrementalSyncPlan(plan: IncrementalSyncPlan): IncrementalSyncPlan {
  for (const threadId of plan.blockedRebuildThreads) {
    plan.plannedRebuilds.delete(threadId);
  }
  return plan;
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
      const expectedPath = stateThread.rolloutPath ?? tracked?.currentPath ?? null;
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
      const canonicalPath = stateThread?.rolloutPath ?? tracked?.currentPath ?? null;
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
    indexedThreads: Map<string, IndexedThreadRow>;
    currentByPath: Map<string, SourceFileSnapshot>;
    currentSnapshots: SourceFileSnapshot[];
    paths: ResolvedPaths;
    stateDbMtime: number | null;
    nowIso: string;
  },
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    const { plan, reader, stateThreads, trackedByThread, indexedThreads, currentByPath, currentSnapshots, paths, stateDbMtime, nowIso } =
      input;
    const touchedThreadData = plan.plannedRebuilds.size > 0 || plan.plannedDeletes.size > 0;
    let touchedThreadMetadata = false;

    yield* db.withTransaction(
      Effect.gen(function* () {
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
          const { thread, canonicalMessages, canonicalSource } = buildThreadRecordFromSessions(
            stateThreads.get(snapshotState.parsed.threadId),
            parsedSessions,
            currentByPath,
          );
          yield* deleteThreadData(db, snapshotState.parsed.threadId);
          yield* insertThread(db, thread);
          yield* insertMessages(db, canonicalMessages);
          yield* upsertThreadSource(
            db,
            snapshotState.parsed.threadId,
            canonicalSource ?? snapshot,
            Number(stateThreads.get(snapshotState.parsed.threadId)?.updatedAt ?? 0),
            nowIso,
          );
        }

        for (const threadId of plan.plannedMetadataRefreshes) {
          const tracked = trackedByThread.get(threadId);
          const indexed = indexedThreads.get(threadId);
          const stateThread = stateThreads.get(threadId);
          if (!tracked || !indexed || !stateThread) {
            continue;
          }
          const changed = yield* refreshThreadMetadataIfNeeded(db, indexed, stateThread, tracked);
          touchedThreadMetadata = touchedThreadMetadata || changed;
          yield* upsertThreadSource(
            db,
            threadId,
            {
              path: tracked.currentPath,
              archived: tracked.archived,
              sizeBytes: tracked.sizeBytes,
              mtimeMs: tracked.mtimeMs,
            },
            Number(stateThread.updatedAt ?? 0),
            nowIso,
          );
        }

        for (const threadId of plan.plannedMissingMarks) {
          const tracked = trackedByThread.get(threadId);
          if (tracked) {
            yield* markThreadSourceMissing(db, tracked, nowIso);
          }
        }

        yield* refreshSyncMeta(db, stateDbMtime, nowIso);
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
    const currentSnapshots = yield* scanSourceFiles(paths);
    const currentByPath = new Map(currentSnapshots.map((snapshot) => [snapshot.path, snapshot]));
    const { readSnapshotState, collectParsedSessionsForThread } = createParsedSnapshotReader(currentSnapshots);

    yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        yield* initializeIndexSchema(db);

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
        finalizeIncrementalSyncPlan(plan);

        const shouldRefreshMetadata = Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0);
        const shouldWrite =
          plan.plannedRebuilds.size > 0 ||
          plan.plannedMetadataRefreshes.size > 0 ||
          plan.plannedMissingMarks.size > 0 ||
          plan.plannedDeletes.size > 0 ||
          shouldRefreshMetadata;

        if (!shouldWrite) {
          return;
        }

        yield* applyIncrementalSyncPlan(db, {
          plan,
          reader: { readSnapshotState, collectParsedSessionsForThread },
          stateThreads,
          trackedByThread,
          indexedThreads,
          currentByPath,
          currentSnapshots,
          paths,
          stateDbMtime,
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

    const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const currentSnapshots = yield* scanSourceFiles(paths);

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        const trackedByThread = yield* readTrackedThreadSources(db);
        const syncMeta = yield* all<{ key: string; value: string }>(db, `SELECT key, value FROM sync_meta`).pipe(
          Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
        );
        if (Number(syncMeta.last_state_db_mtime_ms ?? 0) !== Number(stateDbMtime ?? 0)) {
          return false;
        }

        const trackedByPath = new Map(
          Array.from(trackedByThread.values())
            .filter((tracked) => tracked.missingSince === null)
            .map((tracked) => [tracked.currentPath, tracked]),
        );
        if (trackedByPath.size !== trackedByThread.size) {
          return false;
        }
        if (trackedByPath.size !== currentSnapshots.length) {
          return false;
        }

        for (const snapshot of currentSnapshots) {
          const tracked = trackedByPath.get(snapshot.path);
          if (!tracked || trackedSourceNeedsRebuild(tracked, snapshot)) {
            return false;
          }
        }

        return true;
      }),
    );
  });
}

export function rebuildIndexUnlocked(paths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
  return Effect.gen(function* () {
    const threadMap = yield* readStateThreads(paths.stateDb);
    const allSessions = yield* scanSourceFiles(paths);
    const threadMessages = new Map<string, MessageRecord[]>();
    const canonicalSources = new Map<string, SourceFileSnapshot>();

    for (const entry of allSessions) {
      const parsed = yield* parseJsonlSession(entry.path, entry.archived === 1);
      if (!parsed) {
        continue;
      }

      canonicalSources.set(
        parsed.threadId,
        chooseCanonicalSnapshot(canonicalSources.get(parsed.threadId), entry, threadMap.get(parsed.threadId)),
      );

      const existing = threadMap.get(parsed.threadId) ?? {
        threadId: parsed.threadId,
        rolloutPath: null,
        createdAt: null,
        updatedAt: null,
        source: parsed.meta.source ?? null,
        modelProvider: parsed.meta.modelProvider ?? null,
        cwd: parsed.meta.cwd ?? null,
        title: parsed.meta.title ?? null,
        sandboxPolicy: null,
        approvalMode: null,
        tokensUsed: null,
        archived: parsed.meta.archived ?? 0,
        archivedAt: null,
        gitSha: null,
        gitBranch: null,
        gitOriginUrl: null,
        cliVersion: parsed.meta.cliVersion ?? null,
        firstUserMessage: null,
        agentNickname: null,
        agentRole: null,
        memoryMode: null,
        model: null,
        reasoningEffort: null,
        agentPath: null,
        sourceFile: parsed.meta.sourceFile ?? null,
        sourceKind: parsed.meta.archived ? "archived" : "session",
        fileExists: 1,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        lastMessageAt: null,
      } satisfies ThreadRecord;

      existing.sourceFile = parsed.meta.sourceFile ?? existing.sourceFile;
      existing.sourceKind = parsed.meta.archived ? "archived" : existing.sourceKind;
      existing.fileExists = 1;
      existing.archived = parsed.meta.archived ?? existing.archived;
      existing.cwd = parsed.meta.cwd ?? existing.cwd;
      existing.modelProvider = parsed.meta.modelProvider ?? existing.modelProvider;
      existing.source = parsed.meta.source ?? existing.source;
      existing.cliVersion = parsed.meta.cliVersion ?? existing.cliVersion;

      const collectedMessages = threadMessages.get(parsed.threadId) ?? [];
      collectedMessages.push(...parsed.messages);
      threadMessages.set(parsed.threadId, collectedMessages);

      canonicalSources.set(
        parsed.threadId,
        chooseCanonicalSnapshot(canonicalSources.get(parsed.threadId), entry, threadMap.get(parsed.threadId)),
      );

      threadMap.set(parsed.threadId, existing);
    }

    const canonicalThreadMessages = new Map<string, MessageRecord[]>();
    for (const [threadId, messages] of threadMessages) {
      const { thread, canonicalMessages } = buildThreadRecordFromSessions(
        threadMap.get(threadId),
        [
          {
            threadId,
            meta: threadMap.get(threadId) ?? {},
            messages,
          } as ParsedSessionFile,
        ],
        new Map(Array.from(canonicalSources.entries()).map(([_threadId, snapshot]) => [snapshot.path, snapshot])),
      );
      threadMap.set(threadId, thread);
      canonicalThreadMessages.set(threadId, canonicalMessages);
    }

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        yield* initializeIndexSchema(db);

        const builtAt = new Date().toISOString();

        yield* db.withTransaction(
          Effect.gen(function* () {
            yield* resetIndex(db);

            for (const thread of threadMap.values()) {
              yield* insertThread(db, thread);
            }

            for (const messages of canonicalThreadMessages.values()) {
              yield* insertMessages(db, messages);
            }

            for (const [threadId, snapshot] of canonicalSources) {
              yield* upsertThreadSource(
                db,
                threadId,
                snapshot,
                Number(threadMap.get(threadId)?.updatedAt ?? 0),
                builtAt,
              );
            }

            yield* refreshIndexMeta(db, paths, allSessions, builtAt);
            const stateDbMtime = yield* readModifiedTime(paths.stateDb).pipe(Effect.catchAll(() => Effect.succeed(null)));
            yield* refreshSyncMeta(db, stateDbMtime, builtAt);
          }),
        ).pipe(
          Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
        );

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
        };
      }),
    );
  });
}
