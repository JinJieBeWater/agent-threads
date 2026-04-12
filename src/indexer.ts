import { Effect } from "effect";

import { resolvePaths } from "./config.ts";
import { CliFailure } from "./errors.ts";
import { fileExists } from "./infra/fs.ts";
import { waitForUnlockedIndex, withIndexBuildLock } from "./infra/lock.ts";
import { all, exec, withDatabase } from "./infra/sqlite.ts";
import { chooseThreadTitle, parseJsonlSession, readStateThreads, walkJsonlFiles } from "./source/codex.ts";
import type { GlobalOptions, MessageRecord, ParsedSessionFile, ResolvedPaths, ThreadRecord } from "./types.ts";

type IndexDatabase = Parameters<Parameters<typeof withDatabase>[1]>[0];

export interface RebuildIndexStats {
  builtAt: string;
  threadCount: number;
  messageCount: number;
  activeSessionFileCount: number;
  archivedSessionFileCount: number;
}

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

function findFirstMeaningfulUserMessage(messages: MessageRecord[]): MessageRecord | undefined {
  return messages.find((message) => message.role === "user" && !isNoisyText(message.text));
}

function cleanTitleCandidate(value: string | null | undefined): string | null {
  return !value || isNoisyText(value) ? null : value;
}

function initializeIndexSchema(db: IndexDatabase): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(db, "PRAGMA journal_mode = WAL"),
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
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_provider ON threads(model_provider)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_threads_cwd ON threads(cwd)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq)"),
    exec(db, "CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)"),
  ]).pipe(Effect.asVoid);
}

function resetIndex(db: IndexDatabase): Effect.Effect<void, CliFailure> {
  return Effect.all([
    exec(db, "DELETE FROM meta"),
    exec(db, "DELETE FROM messages"),
    exec(db, "DELETE FROM sqlite_sequence WHERE name = 'messages'"),
    exec(db, "DELETE FROM threads"),
  ]).pipe(Effect.asVoid);
}

function getMetaMap(db: IndexDatabase): Effect.Effect<Record<string, string>, CliFailure> {
  return all<{ key: string; value: string }>(db, `SELECT key, value FROM meta`).pipe(
    Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
  );
}

export function readIndexMeta(paths: ResolvedPaths): Effect.Effect<Record<string, string>, CliFailure> {
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

function isIndexReady(paths: ResolvedPaths): Effect.Effect<boolean, CliFailure> {
  return Effect.gen(function* () {
    const exists = yield* fileExists(paths.indexDb);
    if (!exists) {
      return false;
    }
    const meta = yield* readIndexMeta(paths).pipe(Effect.catchAll(() => Effect.succeed<Record<string, string>>({})));
    return (
      meta.source_id === paths.sourceId &&
      meta.source_kind === paths.sourceKind &&
      meta.source_root === paths.sourceRoot
    );
  });
}

function rebuildIndexUnlocked(paths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
  return Effect.gen(function* () {
    const threadMap = yield* readStateThreads(paths.stateDb);
    const activeSessionFiles = yield* walkJsonlFiles(paths.sessionsDir);
    const archivedSessionFiles = yield* walkJsonlFiles(paths.archivedSessionsDir);
    const allSessions = [
      ...activeSessionFiles.map((filePath) => ({ filePath, archived: false })),
      ...archivedSessionFiles.map((filePath) => ({ filePath, archived: true })),
    ];

    const parsedSessions: ParsedSessionFile[] = [];
    for (const entry of allSessions) {
      const parsed = yield* parseJsonlSession(entry.filePath, entry.archived);
      if (!parsed) {
        continue;
      }

      parsedSessions.push(parsed);
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

      const firstMeaningfulUser = findFirstMeaningfulUserMessage(parsed.messages);
      const firstUser = parsed.messages.find((message) => message.role === "user");
      if (!existing.firstUserMessage) {
        existing.firstUserMessage = firstMeaningfulUser?.text ?? firstUser?.text ?? null;
      }
      existing.title = chooseThreadTitle({
        stateTitle: cleanTitleCandidate(existing.title),
        sessionTitle: cleanTitleCandidate(parsed.meta.title ?? null),
        firstUserMessage: cleanTitleCandidate(firstMeaningfulUser?.text ?? existing.firstUserMessage),
      });

      existing.messageCount = parsed.messages.length;
      existing.userMessageCount = parsed.messages.filter((message) => message.role === "user").length;
      existing.assistantMessageCount = parsed.messages.filter((message) => message.role === "assistant").length;
      existing.lastMessageAt = parsed.messages[parsed.messages.length - 1]?.createdAt ?? existing.lastMessageAt;
      if (!existing.rolloutPath && parsed.meta.sourceFile) {
        existing.rolloutPath = parsed.meta.sourceFile;
      }

      threadMap.set(parsed.threadId, existing);
    }

    return yield* withDatabase(paths.indexDb, (db) =>
      Effect.gen(function* () {
        yield* initializeIndexSchema(db);

        let messageCount = 0;
        const builtAt = new Date().toISOString();

        yield* db.withTransaction(
          Effect.gen(function* () {
            yield* resetIndex(db);

            for (const thread of threadMap.values()) {
              yield* exec(
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

            for (const session of parsedSessions) {
              for (const message of session.messages) {
                yield* exec(
                  db,
                  `INSERT INTO messages (
                    thread_id, seq, message_ref, role, kind, phase, text, created_at, source_file, source_line
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                );
                messageCount += 1;
              }
            }

            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "built_at", builtAt);
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "thread_count", String(threadMap.size));
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "message_count", String(messageCount));
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "active_session_file_count", String(activeSessionFiles.length));
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "archived_session_file_count", String(archivedSessionFiles.length));
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "source_state_db_path", paths.stateDb);
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "source_id", paths.sourceId);
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "source_kind", paths.sourceKind);
            yield* exec(db, `INSERT INTO meta (key, value) VALUES (?, ?)`, "source_root", paths.sourceRoot);
          }),
        ).pipe(
          Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
        );

        return {
          builtAt,
          threadCount: threadMap.size,
          messageCount,
          activeSessionFileCount: activeSessionFiles.length,
          archivedSessionFileCount: archivedSessionFiles.length,
        };
      }),
    );
  });
}

export function rebuildIndex(paths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
  return withIndexBuildLock(paths, rebuildIndexUnlocked(paths));
}

export function ensureIndex(paths: ResolvedPaths, refresh: boolean): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    if (!refresh && (yield* isIndexReady(paths))) {
      return;
    }

    yield* waitForUnlockedIndex(paths);

    if (!refresh && (yield* isIndexReady(paths))) {
      return;
    }

    yield* withIndexBuildLock(
      paths,
      Effect.gen(function* () {
        if (!refresh && (yield* isIndexReady(paths))) {
          return;
        }
        yield* rebuildIndexUnlocked(paths);
      }),
    );
  });
}

export function resolvePathsEffect(options: GlobalOptions): Effect.Effect<ResolvedPaths, CliFailure> {
  return resolvePaths(options);
}
