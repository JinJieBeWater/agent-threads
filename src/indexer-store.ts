import { Effect } from "effect";

import type { CliFailure } from "./errors.ts";
import { fileExists } from "./infra/fs.ts";
import { all, exec, get, withDatabase } from "./infra/sqlite.ts";
import { chooseThreadTitle } from "./source/codex.ts";
import type { MessageRecord, ParsedSessionFile, ResolvedPaths, ThreadRecord } from "./types.ts";

export type IndexDatabase = Parameters<Parameters<typeof withDatabase>[1]>[0];

export interface SourceFileSnapshot {
  path: string;
  archived: 0 | 1;
  sizeBytes: number;
  mtimeMs: number;
}

export interface TrackedThreadSource {
  threadId: string;
  currentPath: string;
  archived: 0 | 1;
  sizeBytes: number;
  mtimeMs: number;
  missingSince: string | null;
  lastStateUpdatedAt: number;
  parserVersion: number;
}

export interface TrackedSourceFile extends TrackedThreadSource {}

export interface IndexedThreadRow extends Record<string, unknown> {
  thread_id: string;
  rollout_path: string | null;
  created_at: number | null;
  updated_at: number | null;
  source: string | null;
  model_provider: string | null;
  cwd: string | null;
  title: string | null;
  sandbox_policy: string | null;
  approval_mode: string | null;
  tokens_used: number | null;
  archived: number | null;
  archived_at: number | null;
  git_sha: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  cli_version: string | null;
  first_user_message: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  memory_mode: string | null;
  model: string | null;
  reasoning_effort: string | null;
  agent_path: string | null;
  source_file: string | null;
  source_kind: string | null;
  file_exists: number | null;
}

export const SCHEMA_VERSION = 5;
export const PARSER_VERSION = 1;
const THREAD_INSERT_CHUNK_SIZE = 500;
const MESSAGE_INSERT_CHUNK_SIZE = 1000;
const THREAD_SOURCE_UPSERT_CHUNK_SIZE = 1000;

const NOISY_TEXT_PATTERNS = [
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
  ">>> APPROVAL REQUEST START",
  ">>> TRANSCRIPT START",
  "tool exec_command call:",
  "tool exec_command result:",
  "The following is the Codex agent history",
  "The Codex agent has requested the following action",
  "<environment_context>",
];

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNoisyText(value: string | null | undefined): boolean {
  const normalized = typeof value === "string" ? normalizeSearchText(value) : "";
  if (normalized.length === 0) {
    return false;
  }
  if (normalized.length > 1_500) {
    return true;
  }
  return NOISY_TEXT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function cleanTitleCandidate(value: string | null | undefined): string | null {
  return !value || isNoisyText(value) ? null : value;
}

function maxIsoTimestamp(left: string | null | undefined, right: string | null | undefined): string | null {
  const leftTime = typeof left === "string" ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === "string" ? Date.parse(right) : Number.NaN;

  if (Number.isNaN(leftTime)) {
    return typeof right === "string" ? right : null;
  }
  if (Number.isNaN(rightTime)) {
    return typeof left === "string" ? left : null;
  }

  return leftTime >= rightTime ? (left as string) : (right as string);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getMetaMap(db: IndexDatabase): Effect.Effect<Record<string, string>, CliFailure> {
  return all<{ key: string; value: string }>(db, `SELECT key, value FROM meta`).pipe(
    Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
  );
}

function getSyncMetaMap(db: IndexDatabase): Effect.Effect<Record<string, string>, CliFailure> {
  return all<{ key: string; value: string }>(db, `SELECT key, value FROM sync_meta`).pipe(
    Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
  );
}

function upsertKeyValues(
  db: IndexDatabase,
  tableName: "meta" | "sync_meta",
  values: Record<string, string>,
): Effect.Effect<void, CliFailure> {
  return Effect.forEach(
    Object.entries(values),
    ([key, value]) =>
      exec(
        db,
        `INSERT INTO ${tableName} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      ),
    { discard: true },
  ).pipe(Effect.asVoid);
}

export function initializeIndexSchema(db: IndexDatabase): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(db, "PRAGMA journal_mode = WAL"),
    exec(db, "PRAGMA busy_timeout = 15000"),
    exec(db, "PRAGMA synchronous = OFF"),
    exec(db, "PRAGMA temp_store = MEMORY"),
    exec(db, "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    exec(
      db,
      `CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        model_provider TEXT,
        cwd TEXT,
        title TEXT,
        sandbox_policy TEXT,
        approval_mode TEXT,
        tokens_used INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT,
        first_user_message TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT,
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT,
        source_file TEXT,
        source_kind TEXT NOT NULL,
        file_exists INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT
      )`,
    ),
    exec(
      db,
      `CREATE TABLE IF NOT EXISTS messages (
        message_pk INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_ref TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT,
        text TEXT NOT NULL,
        created_at TEXT,
        source_file TEXT NOT NULL,
        source_line INTEGER NOT NULL
      )`,
    ),
    exec(
      db,
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        tokenize = "unicode61 remove_diacritics 0 tokenchars '-_./:#'",
        content = '',
        contentless_delete = 1
      )`,
    ),
    exec(
      db,
      `CREATE TABLE IF NOT EXISTS thread_sources (
        current_path TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        archived INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL,
        missing_since TEXT,
        last_state_updated_at INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER NOT NULL
      )`,
    ),
    exec(db, "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_provider ON threads(model_provider)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_cwd ON threads(cwd)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_thread_sources_thread_id ON thread_sources(thread_id)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_thread_sources_path ON thread_sources(current_path)"),
  ]).pipe(Effect.asVoid);
}

export function resetIndex(db: IndexDatabase): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(db, "DELETE FROM meta"),
    exec(db, "DELETE FROM sync_meta"),
    exec(db, "DELETE FROM thread_sources"),
    exec(db, "DELETE FROM messages_fts"),
    exec(db, "DELETE FROM messages"),
    exec(db, "DELETE FROM sqlite_sequence WHERE name = 'messages'"),
    exec(db, "DELETE FROM threads"),
  ]).pipe(Effect.asVoid);
}

export function readTrackedThreadSources(db: IndexDatabase): Effect.Effect<Map<string, TrackedThreadSource>, CliFailure> {
  return readTrackedSourceFiles(db).pipe(
    Effect.map((trackedByPath) => {
      const trackedByThread = new Map<string, TrackedThreadSource>();
      for (const tracked of trackedByPath.values()) {
        const current = trackedByThread.get(tracked.threadId);
        if (!current) {
          trackedByThread.set(tracked.threadId, tracked);
          continue;
        }
        const currentMissing = current.missingSince !== null ? 1 : 0;
        const nextMissing = tracked.missingSince !== null ? 1 : 0;
        if (nextMissing < currentMissing) {
          trackedByThread.set(tracked.threadId, tracked);
          continue;
        }
        if (tracked.archived < current.archived) {
          trackedByThread.set(tracked.threadId, tracked);
          continue;
        }
        if (tracked.mtimeMs > current.mtimeMs) {
          trackedByThread.set(tracked.threadId, tracked);
        }
      }
      return trackedByThread;
    }),
  );
}

export function readTrackedSourceFiles(db: IndexDatabase): Effect.Effect<Map<string, TrackedSourceFile>, CliFailure> {
  return all<Record<string, unknown>>(
    db,
    `
      SELECT
        current_path,
        thread_id,
        archived,
        size_bytes,
        mtime_ms,
        missing_since,
        last_state_updated_at,
        parser_version
      FROM thread_sources
    `,
  ).pipe(
    Effect.map((rows) => {
      const tracked = new Map<string, TrackedSourceFile>();
      for (const row of rows) {
        tracked.set(String(row.current_path), {
          threadId: String(row.thread_id),
          currentPath: String(row.current_path),
          archived: Number(row.archived ?? 0) === 1 ? 1 : 0,
          sizeBytes: Number(row.size_bytes ?? 0),
          mtimeMs: Number(row.mtime_ms ?? 0),
          missingSince: typeof row.missing_since === "string" && row.missing_since.length > 0 ? row.missing_since : null,
          lastStateUpdatedAt: Number(row.last_state_updated_at ?? 0),
          parserVersion: Number(row.parser_version ?? 0),
        });
      }
      return tracked;
    }),
  );
}

export function readIndexedThreads(db: IndexDatabase): Effect.Effect<Map<string, IndexedThreadRow>, CliFailure> {
  return all<IndexedThreadRow>(db, `SELECT * FROM threads`).pipe(
    Effect.map((rows) => new Map(rows.map((row) => [String(row.thread_id), row]))),
  );
}

export function upsertThreadSource(
  db: IndexDatabase,
  threadId: string,
  snapshot: SourceFileSnapshot,
  lastStateUpdatedAt: number,
  seenAt: string,
): Effect.Effect<void, CliFailure> {
  return exec(
    db,
    `INSERT INTO thread_sources (
      current_path, thread_id, archived, size_bytes, mtime_ms, last_seen_at,
      missing_since, last_state_updated_at, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(current_path) DO UPDATE SET
      thread_id = excluded.thread_id,
      archived = excluded.archived,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      last_seen_at = excluded.last_seen_at,
      missing_since = NULL,
      last_state_updated_at = excluded.last_state_updated_at,
      parser_version = excluded.parser_version`,
    snapshot.path,
    threadId,
    snapshot.archived,
    snapshot.sizeBytes,
    snapshot.mtimeMs,
    seenAt,
    lastStateUpdatedAt,
    PARSER_VERSION,
  );
}

export function upsertThreadSources(
  db: IndexDatabase,
  rows: Array<{
    threadId: string;
    snapshot: SourceFileSnapshot;
    lastStateUpdatedAt: number;
    seenAt: string;
  }>,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const chunk of chunkArray(rows, THREAD_SOURCE_UPSERT_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, NULL, ?, ?)").join(", ");
      const params = chunk.flatMap(({ threadId, snapshot, lastStateUpdatedAt, seenAt }) => [
        snapshot.path,
        threadId,
        snapshot.archived,
        snapshot.sizeBytes,
        snapshot.mtimeMs,
        seenAt,
        lastStateUpdatedAt,
        PARSER_VERSION,
      ]);

      yield* exec(
        db,
        `INSERT INTO thread_sources (
          current_path, thread_id, archived, size_bytes, mtime_ms, last_seen_at,
          missing_since, last_state_updated_at, parser_version
        ) VALUES ${placeholders}
        ON CONFLICT(current_path) DO UPDATE SET
          thread_id = excluded.thread_id,
          archived = excluded.archived,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          last_seen_at = excluded.last_seen_at,
          missing_since = NULL,
          last_state_updated_at = excluded.last_state_updated_at,
          parser_version = excluded.parser_version`,
        ...params,
      );
    }
  }).pipe(Effect.asVoid);
}

export function markThreadSourceMissing(
  db: IndexDatabase,
  tracked: TrackedThreadSource,
  seenAt: string,
): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(
      db,
      `UPDATE thread_sources
        SET missing_since = COALESCE(missing_since, ?), last_seen_at = ?
        WHERE thread_id = ?`,
      seenAt,
      seenAt,
      tracked.threadId,
    ),
    exec(
      db,
      `UPDATE threads
        SET file_exists = 0, source_file = ?, source_kind = ?
        WHERE thread_id = ?`,
      tracked.currentPath,
      tracked.archived === 1 ? "archived" : "session",
      tracked.threadId,
    ),
  ]).pipe(Effect.asVoid);
}

export function deleteThreadSource(db: IndexDatabase, threadId: string): Effect.Effect<void, CliFailure> {
  return exec(db, `DELETE FROM thread_sources WHERE thread_id = ?`, threadId);
}

export function deleteTrackedSourcePath(db: IndexDatabase, path: string): Effect.Effect<void, CliFailure> {
  return exec(db, `DELETE FROM thread_sources WHERE current_path = ?`, path);
}

export function touchThreadSourcesMetadata(
  db: IndexDatabase,
  threadId: string,
  lastStateUpdatedAt: number,
  seenAt: string,
): Effect.Effect<void, CliFailure> {
  return exec(
    db,
    `UPDATE thread_sources
      SET last_state_updated_at = ?, last_seen_at = ?, missing_since = NULL
      WHERE thread_id = ?`,
    lastStateUpdatedAt,
    seenAt,
    threadId,
  );
}

export function insertThread(db: IndexDatabase, thread: ThreadRecord): Effect.Effect<void, CliFailure> {
  return exec(
    db,
    `INSERT INTO threads (
      thread_id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, archived, archived_at, git_sha, git_branch,
      git_origin_url, cli_version, first_user_message, agent_nickname, agent_role, memory_mode,
      model, reasoning_effort, agent_path, source_file, source_kind, file_exists, message_count,
      user_message_count, assistant_message_count, last_message_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    thread.threadId,
    thread.rolloutPath ?? "",
    thread.createdAt ?? 0,
    thread.updatedAt ?? 0,
    thread.source ?? "",
    thread.modelProvider ?? "",
    thread.cwd ?? "",
    thread.title ?? "",
    thread.sandboxPolicy ?? "",
    thread.approvalMode ?? "",
    thread.tokensUsed ?? 0,
    thread.archived,
    thread.archivedAt ?? 0,
    thread.gitSha ?? "",
    thread.gitBranch ?? "",
    thread.gitOriginUrl ?? "",
    thread.cliVersion ?? "",
    thread.firstUserMessage ?? "",
    thread.agentNickname ?? "",
    thread.agentRole ?? "",
    thread.memoryMode ?? "",
    thread.model ?? "",
    thread.reasoningEffort ?? "",
    thread.agentPath ?? "",
    thread.sourceFile ?? "",
    thread.sourceKind,
    thread.fileExists,
    thread.messageCount,
    thread.userMessageCount,
    thread.assistantMessageCount,
    thread.lastMessageAt ?? "",
  );
}

export function insertThreads(db: IndexDatabase, threads: ThreadRecord[]): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const chunk of chunkArray(threads, THREAD_INSERT_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = chunk.flatMap((thread) => [
        thread.threadId,
        thread.rolloutPath ?? "",
        thread.createdAt ?? 0,
        thread.updatedAt ?? 0,
        thread.source ?? "",
        thread.modelProvider ?? "",
        thread.cwd ?? "",
        thread.title ?? "",
        thread.sandboxPolicy ?? "",
        thread.approvalMode ?? "",
        thread.tokensUsed ?? 0,
        thread.archived,
        thread.archivedAt ?? 0,
        thread.gitSha ?? "",
        thread.gitBranch ?? "",
        thread.gitOriginUrl ?? "",
        thread.cliVersion ?? "",
        thread.firstUserMessage ?? "",
        thread.agentNickname ?? "",
        thread.agentRole ?? "",
        thread.memoryMode ?? "",
        thread.model ?? "",
        thread.reasoningEffort ?? "",
        thread.agentPath ?? "",
        thread.sourceFile ?? "",
        thread.sourceKind,
        thread.fileExists,
        thread.messageCount,
        thread.userMessageCount,
        thread.assistantMessageCount,
        thread.lastMessageAt ?? "",
      ]);

      yield* exec(
        db,
        `INSERT INTO threads (
          thread_id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, archived, archived_at, git_sha, git_branch,
          git_origin_url, cli_version, first_user_message, agent_nickname, agent_role, memory_mode,
          model, reasoning_effort, agent_path, source_file, source_kind, file_exists, message_count,
          user_message_count, assistant_message_count, last_message_at
        ) VALUES ${placeholders}`,
        ...params,
      );
    }
  }).pipe(Effect.asVoid);
}

export function insertMessages(db: IndexDatabase, messages: MessageRecord[]): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const chunk of chunkArray(messages, MESSAGE_INSERT_CHUNK_SIZE)) {
      const messagePlaceholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const messageParams = chunk.flatMap((message) => [
        message.threadId,
        message.seq,
        message.messageRef,
        message.role,
        message.kind,
        message.phase ?? "",
        message.text,
        message.createdAt ?? "",
        message.sourceFile,
        message.sourceLine,
      ]);

      const insertedRows = yield* all<{ message_pk: number; text: string }>(
        db,
        `INSERT INTO messages (
          thread_id, seq, message_ref, role, kind, phase, text, created_at, source_file, source_line
        ) VALUES ${messagePlaceholders}
        RETURNING message_pk, text`,
        ...messageParams,
      );

      if (insertedRows.length === 0) {
        continue;
      }

      const ftsPlaceholders = insertedRows.map(() => "(?, ?)").join(", ");
      const ftsParams = insertedRows.flatMap((row) => [row.message_pk, row.text]);
      yield* exec(db, `INSERT INTO messages_fts(rowid, text) VALUES ${ftsPlaceholders}`, ...ftsParams);
    }
  }).pipe(Effect.asVoid);
}

export function insertMessagesTableOnly(db: IndexDatabase, messages: MessageRecord[]): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    for (const chunk of chunkArray(messages, MESSAGE_INSERT_CHUNK_SIZE)) {
      const messagePlaceholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const messageParams = chunk.flatMap((message) => [
        message.threadId,
        message.seq,
        message.messageRef,
        message.role,
        message.kind,
        message.phase ?? "",
        message.text,
        message.createdAt ?? "",
        message.sourceFile,
        message.sourceLine,
      ]);

      yield* exec(
        db,
        `INSERT INTO messages (
          thread_id, seq, message_ref, role, kind, phase, text, created_at, source_file, source_line
        ) VALUES ${messagePlaceholders}`,
        ...messageParams,
      );
    }
  }).pipe(Effect.asVoid);
}

export function rebuildMessagesFtsFromMessages(db: IndexDatabase): Effect.Effect<void, CliFailure> {
  return exec(
    db,
    `INSERT INTO messages_fts(rowid, text)
     SELECT message_pk, text
     FROM messages
     ORDER BY message_pk ASC`,
  );
}

export function deleteThreadData(db: IndexDatabase, threadId: string): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(db, `DELETE FROM messages_fts WHERE rowid IN (SELECT message_pk FROM messages WHERE thread_id = ?)`, threadId),
    exec(db, `DELETE FROM messages WHERE thread_id = ?`, threadId),
    exec(db, `DELETE FROM threads WHERE thread_id = ?`, threadId),
  ]).pipe(Effect.asVoid);
}

export function refreshIndexMeta(
  db: IndexDatabase,
  paths: ResolvedPaths,
  snapshots: SourceFileSnapshot[],
  builtAt: string,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
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
    yield* upsertKeyValues(db, "meta", {
      built_at: builtAt,
      thread_count: String(totals.threadCount),
      message_count: String(totals.messageCount),
      active_session_file_count: String(snapshots.filter((snapshot) => snapshot.archived === 0).length),
      archived_session_file_count: String(snapshots.filter((snapshot) => snapshot.archived === 1).length),
      source_state_db_path: paths.stateDb,
      source_id: paths.sourceId,
      source_kind: paths.sourceKind,
      source_root: paths.sourceRoot,
    });
  });
}

export function refreshIndexMetaFromTrackedSources(
  db: IndexDatabase,
  paths: ResolvedPaths,
  builtAt: string,
): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
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

    const sourceCounts = yield* get<Record<string, unknown>>(
      db,
      `
        SELECT
          SUM(CASE WHEN archived = 0 AND missing_since IS NULL THEN 1 ELSE 0 END) AS active_session_file_count,
          SUM(CASE WHEN archived = 1 AND missing_since IS NULL THEN 1 ELSE 0 END) AS archived_session_file_count
        FROM thread_sources
      `,
    ).pipe(
      Effect.map((row) => ({
        activeSessionFileCount: Number(row?.active_session_file_count ?? 0),
        archivedSessionFileCount: Number(row?.archived_session_file_count ?? 0),
      })),
    );

    yield* upsertKeyValues(db, "meta", {
      built_at: builtAt,
      thread_count: String(totals.threadCount),
      message_count: String(totals.messageCount),
      active_session_file_count: String(sourceCounts.activeSessionFileCount),
      archived_session_file_count: String(sourceCounts.archivedSessionFileCount),
      source_state_db_path: paths.stateDb,
      source_id: paths.sourceId,
      source_kind: paths.sourceKind,
      source_root: paths.sourceRoot,
    });
  });
}

export function refreshSyncMeta(
  db: IndexDatabase,
  stateDbMtime: number | null,
  sourceFingerprint: string | null,
  sourceDirectoryManifest: string | null,
  logsHighWater: number | null,
  syncedAt: string,
): Effect.Effect<void, CliFailure> {
  return upsertKeyValues(db, "sync_meta", {
    schema_version: String(SCHEMA_VERSION),
    parser_version: String(PARSER_VERSION),
    last_sync_at: syncedAt,
    last_state_db_mtime_ms: String(stateDbMtime ?? 0),
    last_source_fingerprint: sourceFingerprint ?? "",
    last_source_directory_manifest: sourceDirectoryManifest ?? "",
    last_logs_high_water: String(logsHighWater ?? 0),
  });
}

export function chooseCanonicalSnapshot(
  existing: SourceFileSnapshot | undefined,
  next: SourceFileSnapshot,
  stateThread: ThreadRecord | undefined,
): SourceFileSnapshot {
  if (!existing) {
    return next;
  }
  if (stateThread?.rolloutPath === next.path) {
    return next;
  }
  if (stateThread?.rolloutPath === existing.path) {
    return existing;
  }
  if (existing.archived === 1 && next.archived === 0) {
    return next;
  }
  return existing;
}

export function buildThreadRecordFromSessions(
  stateThread: ThreadRecord | undefined,
  parsedSessions: ParsedSessionFile[],
  snapshotByPath: Map<string, SourceFileSnapshot>,
): { thread: ThreadRecord; canonicalMessages: MessageRecord[]; canonicalSource: SourceFileSnapshot | null } {
  const firstParsed = parsedSessions[0];
  if (!firstParsed) {
    throw new Error("buildThreadRecordFromSessions requires at least one parsed session");
  }
  const canonicalThreadId = firstParsed.threadId;

  const thread = stateThread
    ? { ...stateThread }
    : ({
        threadId: canonicalThreadId,
        rolloutPath: null,
        createdAt: null,
        updatedAt: null,
        source: firstParsed.meta.source ?? null,
        modelProvider: firstParsed.meta.modelProvider ?? null,
        cwd: firstParsed.meta.cwd ?? null,
        title: firstParsed.meta.title ?? null,
        sandboxPolicy: null,
        approvalMode: null,
        tokensUsed: null,
        archived: firstParsed.meta.archived ?? 0,
        archivedAt: null,
        gitSha: null,
        gitBranch: null,
        gitOriginUrl: null,
        cliVersion: firstParsed.meta.cliVersion ?? null,
        firstUserMessage: null,
        agentNickname: null,
        agentRole: null,
        memoryMode: null,
        model: null,
        reasoningEffort: null,
        agentPath: null,
        sourceFile: firstParsed.meta.sourceFile ?? null,
        sourceKind: firstParsed.meta.archived ? "archived" : "session",
        fileExists: 1,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        lastMessageAt: null,
      } satisfies ThreadRecord);

  const canonicalMessages: MessageRecord[] = [];
  let canonicalSource: SourceFileSnapshot | null = null;
  let lastMessageAt = thread.lastMessageAt;
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  for (const parsed of parsedSessions) {
    thread.sourceFile = parsed.meta.sourceFile ?? thread.sourceFile;
    thread.sourceKind = parsed.meta.archived ? "archived" : thread.sourceKind;
    thread.fileExists = 1;
    thread.archived = parsed.meta.archived ?? thread.archived;
    thread.cwd = parsed.meta.cwd ?? thread.cwd;
    thread.modelProvider = parsed.meta.modelProvider ?? thread.modelProvider;
    thread.source = parsed.meta.source ?? thread.source;
    thread.cliVersion = parsed.meta.cliVersion ?? thread.cliVersion;

    let parsedFirstMeaningfulUser: string | null = null;
    let parsedFirstUser: string | null = null;
    for (const message of parsed.messages) {
      if (message.role === "user") {
        userMessageCount += 1;
        parsedFirstUser ??= message.text;
        if (!isNoisyText(message.text)) {
          parsedFirstMeaningfulUser ??= message.text;
        }
      } else if (message.role === "assistant") {
        assistantMessageCount += 1;
      }

      const seq = canonicalMessages.length + 1;
      canonicalMessages.push({
        ...message,
        threadId: canonicalThreadId,
        seq,
        messageRef: `${canonicalThreadId}:${seq}`,
      });
      lastMessageAt = maxIsoTimestamp(lastMessageAt, message.createdAt);
    }

    if (!thread.firstUserMessage) {
      thread.firstUserMessage = parsedFirstMeaningfulUser ?? parsedFirstUser ?? null;
    }
    thread.title = chooseThreadTitle({
      stateTitle: cleanTitleCandidate(thread.title),
      sessionTitle: cleanTitleCandidate(parsed.meta.title ?? null),
      firstUserMessage: cleanTitleCandidate(parsedFirstMeaningfulUser ?? thread.firstUserMessage),
    });

    if (!thread.rolloutPath && parsed.meta.sourceFile) {
      thread.rolloutPath = parsed.meta.sourceFile;
    }

    const snapshot = parsed.meta.sourceFile ? snapshotByPath.get(parsed.meta.sourceFile) : undefined;
    if (snapshot) {
      canonicalSource = chooseCanonicalSnapshot(canonicalSource ?? undefined, snapshot, stateThread) ?? null;
    }
  }

  thread.messageCount = canonicalMessages.length;
  thread.userMessageCount = userMessageCount;
  thread.assistantMessageCount = assistantMessageCount;
  thread.lastMessageAt = lastMessageAt;
  thread.title = chooseThreadTitle({
    stateTitle: cleanTitleCandidate(thread.title),
    firstUserMessage: cleanTitleCandidate(thread.firstUserMessage),
  });

  if (canonicalSource) {
    thread.sourceFile = canonicalSource.path;
    thread.sourceKind = canonicalSource.archived === 1 ? "archived" : "session";
    thread.fileExists = 1;
  }

  return { thread, canonicalMessages, canonicalSource };
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function refreshThreadMetadataIfNeeded(
  db: IndexDatabase,
  indexed: IndexedThreadRow,
  stateThread: ThreadRecord,
  tracked: TrackedThreadSource,
): Effect.Effect<boolean, CliFailure> {
  const desired = {
    rolloutPath: stateThread.rolloutPath ?? toNullableString(indexed.rollout_path),
    createdAt: stateThread.createdAt ?? toNullableNumber(indexed.created_at),
    updatedAt: stateThread.updatedAt ?? toNullableNumber(indexed.updated_at),
    source: stateThread.source ?? toNullableString(indexed.source),
    modelProvider: stateThread.modelProvider ?? toNullableString(indexed.model_provider),
    cwd: stateThread.cwd ?? toNullableString(indexed.cwd),
    title:
      chooseThreadTitle({
        stateTitle: cleanTitleCandidate(stateThread.title),
        firstUserMessage: cleanTitleCandidate(indexed.first_user_message),
      }) ?? toNullableString(indexed.title),
    sandboxPolicy: stateThread.sandboxPolicy ?? toNullableString(indexed.sandbox_policy),
    approvalMode: stateThread.approvalMode ?? toNullableString(indexed.approval_mode),
    tokensUsed: stateThread.tokensUsed ?? toNullableNumber(indexed.tokens_used),
    archived: stateThread.archived,
    archivedAt: stateThread.archivedAt ?? toNullableNumber(indexed.archived_at),
    gitSha: stateThread.gitSha ?? toNullableString(indexed.git_sha),
    gitBranch: stateThread.gitBranch ?? toNullableString(indexed.git_branch),
    gitOriginUrl: stateThread.gitOriginUrl ?? toNullableString(indexed.git_origin_url),
    cliVersion: stateThread.cliVersion ?? toNullableString(indexed.cli_version),
    agentNickname: stateThread.agentNickname ?? toNullableString(indexed.agent_nickname),
    agentRole: stateThread.agentRole ?? toNullableString(indexed.agent_role),
    memoryMode: stateThread.memoryMode ?? toNullableString(indexed.memory_mode),
    model: stateThread.model ?? toNullableString(indexed.model),
    reasoningEffort: stateThread.reasoningEffort ?? toNullableString(indexed.reasoning_effort),
    agentPath: stateThread.agentPath ?? toNullableString(indexed.agent_path),
    sourceFile: tracked.currentPath,
    sourceKind: tracked.archived === 1 ? "archived" : "session",
    fileExists: tracked.missingSince ? 0 : 1,
  };

  const hasDiff =
    desired.rolloutPath !== toNullableString(indexed.rollout_path) ||
    desired.createdAt !== toNullableNumber(indexed.created_at) ||
    desired.updatedAt !== toNullableNumber(indexed.updated_at) ||
    desired.source !== toNullableString(indexed.source) ||
    desired.modelProvider !== toNullableString(indexed.model_provider) ||
    desired.cwd !== toNullableString(indexed.cwd) ||
    desired.title !== toNullableString(indexed.title) ||
    desired.sandboxPolicy !== toNullableString(indexed.sandbox_policy) ||
    desired.approvalMode !== toNullableString(indexed.approval_mode) ||
    desired.tokensUsed !== toNullableNumber(indexed.tokens_used) ||
    desired.archived !== Number(indexed.archived ?? 0) ||
    desired.archivedAt !== toNullableNumber(indexed.archived_at) ||
    desired.gitSha !== toNullableString(indexed.git_sha) ||
    desired.gitBranch !== toNullableString(indexed.git_branch) ||
    desired.gitOriginUrl !== toNullableString(indexed.git_origin_url) ||
    desired.cliVersion !== toNullableString(indexed.cli_version) ||
    desired.agentNickname !== toNullableString(indexed.agent_nickname) ||
    desired.agentRole !== toNullableString(indexed.agent_role) ||
    desired.memoryMode !== toNullableString(indexed.memory_mode) ||
    desired.model !== toNullableString(indexed.model) ||
    desired.reasoningEffort !== toNullableString(indexed.reasoning_effort) ||
    desired.agentPath !== toNullableString(indexed.agent_path) ||
    desired.sourceFile !== toNullableString(indexed.source_file) ||
    desired.sourceKind !== toNullableString(indexed.source_kind) ||
    desired.fileExists !== Number(indexed.file_exists ?? 0);

  if (!hasDiff) {
    return Effect.succeed(false);
  }

  return exec(
    db,
    `
      UPDATE threads
      SET
        rollout_path = ?,
        created_at = ?,
        updated_at = ?,
        source = ?,
        model_provider = ?,
        cwd = ?,
        title = ?,
        sandbox_policy = ?,
        approval_mode = ?,
        tokens_used = ?,
        archived = ?,
        archived_at = ?,
        git_sha = ?,
        git_branch = ?,
        git_origin_url = ?,
        cli_version = ?,
        agent_nickname = ?,
        agent_role = ?,
        memory_mode = ?,
        model = ?,
        reasoning_effort = ?,
        agent_path = ?,
        source_file = ?,
        source_kind = ?,
        file_exists = ?
      WHERE thread_id = ?
    `,
    desired.rolloutPath ?? "",
    desired.createdAt ?? 0,
    desired.updatedAt ?? 0,
    desired.source ?? "",
    desired.modelProvider ?? "",
    desired.cwd ?? "",
    desired.title ?? "",
    desired.sandboxPolicy ?? "",
    desired.approvalMode ?? "",
    desired.tokensUsed ?? 0,
    desired.archived,
    desired.archivedAt ?? 0,
    desired.gitSha ?? "",
    desired.gitBranch ?? "",
    desired.gitOriginUrl ?? "",
    desired.cliVersion ?? "",
    desired.agentNickname ?? "",
    desired.agentRole ?? "",
    desired.memoryMode ?? "",
    desired.model ?? "",
    desired.reasoningEffort ?? "",
    desired.agentPath ?? "",
    desired.sourceFile ?? "",
    desired.sourceKind,
    desired.fileExists,
    stateThread.threadId,
  ).pipe(Effect.as(true));
}

export function readIndexMetaInternal(paths: ResolvedPaths): Effect.Effect<Record<string, string>, CliFailure> {
  return Effect.gen(function* () {
    const exists = yield* fileExists(paths.indexDb);
    if (!exists) {
      return {};
    }
    return yield* withDatabase(paths.indexDb, (db) => getMetaMap(db)).pipe(
      Effect.catchAll(() => Effect.succeed({})),
    );
  });
}

export function isIndexUsable(paths: ResolvedPaths): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    const exists = yield* fileExists(paths.indexDb);
    if (!exists) {
      return false;
    }

    const meta = yield* readIndexMetaInternal(paths).pipe(
      Effect.catchAll(() => Effect.succeed<Record<string, string>>({})),
    );
    const sourceMatches =
      meta.source_id === paths.sourceId &&
      meta.source_kind === paths.sourceKind &&
      meta.source_root === paths.sourceRoot;
    if (!sourceMatches) {
      return false;
    }

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        const tables = yield* all<{ name: string }>(
          db,
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'messages_fts', 'threads', 'thread_sources', 'sync_meta')`,
        );
        if (tables.length < 5) {
          return false;
        }

        const syncMeta = yield* getSyncMetaMap(db);
        if (Number(syncMeta.schema_version ?? 0) !== SCHEMA_VERSION) {
          return false;
        }
        if (Number(syncMeta.parser_version ?? 0) !== PARSER_VERSION) {
          return false;
        }

        const totals = (yield* get<Record<string, unknown>>(
          db,
          `
            SELECT
              (SELECT COUNT(*) FROM messages) AS actual_messages,
              (SELECT COALESCE(SUM(message_count), 0) FROM threads) AS thread_message_sum,
              EXISTS(
                SELECT 1
                FROM messages
                GROUP BY thread_id, seq
                HAVING COUNT(*) > 1
                LIMIT 1
              ) AS has_duplicate_seq
          `,
        )) ?? {
          actual_messages: 0,
          thread_message_sum: 0,
          has_duplicate_seq: 0,
        };

        return (
          Number(totals.actual_messages ?? 0) === Number(totals.thread_message_sum ?? 0) &&
          Number(totals.has_duplicate_seq ?? 0) === 0
        );
      }).pipe(Effect.catchAll(() => Effect.succeed(false))),
    );
  });
}

export function trackedSourceNeedsRebuild(
  tracked: TrackedThreadSource | undefined,
  snapshot: SourceFileSnapshot,
): boolean {
  return (
    !tracked ||
    tracked.currentPath !== snapshot.path ||
    tracked.archived !== snapshot.archived ||
    tracked.sizeBytes !== snapshot.sizeBytes ||
    tracked.mtimeMs !== Math.floor(snapshot.mtimeMs) ||
    tracked.parserVersion !== PARSER_VERSION ||
    tracked.missingSince !== null
  );
}
