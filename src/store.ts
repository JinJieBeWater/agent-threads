import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename } from "node:path";
import { Database } from "bun:sqlite";

import { ensureParentDirectory } from "./config.ts";
import type { MessageRecord, ParsedSessionFile, ResolvedPaths, ThreadRecord } from "./types.ts";

type SqlDatabase = Database;
const ROLLOUT_THREAD_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
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
const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_WAIT_MS = 15_000;
const INDEX_LOCK_POLL_MS = 100;
const SNIPPET_LENGTH = 220;

function openDatabase(filePath: string): SqlDatabase {
  const db = new Database(filePath);
  db.exec("PRAGMA busy_timeout = 3000;");
  return db;
}

function all<T extends Record<string, unknown>>(
  db: SqlDatabase,
  sql: string,
  ...params: Array<string | number>
): T[] {
  return db.query(sql).all(...params) as T[];
}

function get<T extends Record<string, unknown>>(
  db: SqlDatabase,
  sql: string,
  ...params: Array<string | number>
): T | null {
  return (db.query(sql).get(...params) as T | null) ?? null;
}

function normalizeInlineText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function readTextValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim().length > 0 ? value : null;
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildSnippet(value: string, query: string, maxLength = SNIPPET_LENGTH): string {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) {
    return "";
  }

  const normalizedQuery = normalizeSearchText(query).toLowerCase();
  if (normalizedQuery.length === 0) {
    return truncateText(normalized, maxLength);
  }

  const lower = normalized.toLowerCase();
  const matchIndex = lower.indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return truncateText(normalized, maxLength);
  }

  const padding = Math.max(24, Math.floor((maxLength - normalizedQuery.length) / 2));
  let start = Math.max(0, matchIndex - padding);
  let end = Math.min(normalized.length, matchIndex + normalizedQuery.length + padding);

  if (end - start < maxLength) {
    start = Math.max(0, end - maxLength);
    end = Math.min(normalized.length, start + maxLength);
  }

  let snippet = normalized.slice(start, end).trim();
  if (start > 0) {
    snippet = `...${snippet}`;
  }
  if (end < normalized.length) {
    snippet = `${snippet}...`;
  }
  return snippet;
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

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function getIndexLockFile(paths: ResolvedPaths): string {
  return `${paths.indexDb}.lock`;
}

function hasActiveIndexLock(paths: ResolvedPaths): boolean {
  const lockFile = getIndexLockFile(paths);
  if (!existsSync(lockFile)) {
    return false;
  }
  pruneStaleIndexLock(lockFile);
  return existsSync(lockFile);
}

function pruneStaleIndexLock(lockFile: string): void {
  try {
    const lockAgeMs = Date.now() - statSync(lockFile).mtimeMs;
    if (lockAgeMs <= INDEX_LOCK_STALE_MS) {
      return;
    }
    unlinkSync(lockFile);
  } catch {
    return;
  }
}

function readIndexMetaSafe(paths: ResolvedPaths): Record<string, string> {
  try {
    return readIndexMeta(paths);
  } catch {
    return {};
  }
}

function isIndexReady(paths: ResolvedPaths): boolean {
  if (!existsSync(paths.indexDb)) {
    return false;
  }

  const meta = readIndexMetaSafe(paths);
  return (
    meta.source_id === paths.sourceId &&
    meta.source_kind === paths.sourceKind &&
    meta.source_root === paths.sourceRoot
  );
}

function withIndexBuildLock<T>(paths: ResolvedPaths, callback: () => T): T {
  const lockFile = getIndexLockFile(paths);
  ensureParentDirectory(lockFile);
  const startedAt = Date.now();
  let lockFd: number | null = null;

  while (lockFd === null) {
    try {
      lockFd = openSync(lockFile, "wx");
      writeFileSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }

      pruneStaleIndexLock(lockFile);
      if (!existsSync(lockFile)) {
        continue;
      }

      if (Date.now() - startedAt > INDEX_LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for index lock: ${lockFile}`);
      }

      sleepSync(INDEX_LOCK_POLL_MS);
    }
  }

  try {
    return callback();
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore lock cleanup races from parallel readers.
    }
  }
}

function looksNoisyTitle(title: string | null): boolean {
  return isNoisyText(title) || Boolean(title && title.includes("[1] user:"));
}

function chooseThreadTitle(input: {
  stateTitle?: string | null;
  sessionTitle?: string | null;
  firstUserMessage?: string | null;
}): string | null {
  const stateTitle = normalizeInlineText(input.stateTitle);
  const sessionTitle = normalizeInlineText(input.sessionTitle);
  const firstUserMessage = normalizeInlineText(input.firstUserMessage);

  if (stateTitle && !looksNoisyTitle(stateTitle)) {
    return stateTitle;
  }
  if (sessionTitle && !looksNoisyTitle(sessionTitle)) {
    return sessionTitle;
  }
  if (firstUserMessage && !looksNoisyTitle(firstUserMessage)) {
    return firstUserMessage;
  }
  return null;
}

function extractFallbackThreadId(fileName: string): string {
  const matchedId = fileName.match(ROLLOUT_THREAD_ID_PATTERN)?.[1];
  if (matchedId) {
    return matchedId;
  }

  return fileName.replace(/\.jsonl$/i, "").replace(/^rollout-/, "");
}

function walkJsonlFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const result: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }

  result.sort((left, right) => left.localeCompare(right));
  return result;
}

function readStateThreads(stateDbPath: string): Map<string, ThreadRecord> {
  const threads = new Map<string, ThreadRecord>();
  if (!existsSync(stateDbPath)) {
    return threads;
  }

  const db = openDatabase(stateDbPath);
  try {
    const rows = all<Record<string, unknown>>(
      db,
      `
          SELECT
            id,
            rollout_path,
            created_at,
            updated_at,
            source,
            model_provider,
            cwd,
            title,
            sandbox_policy,
            approval_mode,
            tokens_used,
            archived,
            archived_at,
            git_sha,
            git_branch,
            git_origin_url,
            cli_version,
            first_user_message,
            agent_nickname,
            agent_role,
            memory_mode,
            model,
            reasoning_effort,
            agent_path
          FROM threads
        `,
    );

    for (const row of rows) {
      const threadId = String(row.id);
      threads.set(threadId, {
        threadId,
        rolloutPath: (row.rollout_path as string | null) ?? null,
        createdAt: typeof row.created_at === "number" ? row.created_at : null,
        updatedAt: typeof row.updated_at === "number" ? row.updated_at : null,
        source: (row.source as string | null) ?? null,
        modelProvider: (row.model_provider as string | null) ?? null,
        cwd: (row.cwd as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        sandboxPolicy: (row.sandbox_policy as string | null) ?? null,
        approvalMode: (row.approval_mode as string | null) ?? null,
        tokensUsed: typeof row.tokens_used === "number" ? row.tokens_used : null,
        archived: Number(row.archived ?? 0),
        archivedAt: typeof row.archived_at === "number" ? row.archived_at : null,
        gitSha: (row.git_sha as string | null) ?? null,
        gitBranch: (row.git_branch as string | null) ?? null,
        gitOriginUrl: (row.git_origin_url as string | null) ?? null,
        cliVersion: (row.cli_version as string | null) ?? null,
        firstUserMessage: (row.first_user_message as string | null) ?? null,
        agentNickname: (row.agent_nickname as string | null) ?? null,
        agentRole: (row.agent_role as string | null) ?? null,
        memoryMode: (row.memory_mode as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        reasoningEffort: (row.reasoning_effort as string | null) ?? null,
        agentPath: (row.agent_path as string | null) ?? null,
        sourceFile: (row.rollout_path as string | null) ?? null,
        sourceKind: Number(row.archived ?? 0) === 1 ? "archived" : "state",
        fileExists: row.rollout_path && existsSync(String(row.rollout_path)) ? 1 : 0,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        lastMessageAt: null,
      });
    }
  } finally {
    db.close();
  }

  return threads;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeInlineText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function collectResponseMessageText(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typedItem = item as Record<string, unknown>;
    if (typedItem.type === "output_text" || typedItem.type === "input_text") {
      const text = readTextValue(typedItem.text);
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function inferRole(value: unknown): MessageRecord["role"] {
  return value === "user" || value === "assistant" || value === "system" ? value : "unknown";
}

function isStructuralDuplicate(
  previous: Pick<MessageRecord, "role" | "kind" | "text"> | null,
  current: Pick<MessageRecord, "role" | "kind" | "text">,
): boolean {
  if (!previous || previous.role !== current.role || previous.text !== current.text) {
    return false;
  }

  if (current.role === "user") {
    return (
      (previous.kind === "message" && current.kind === "user_message") ||
      (previous.kind === "user_message" && current.kind === "message")
    );
  }

  if (current.role === "assistant") {
    return (
      (previous.kind === "message" && current.kind === "agent_message") ||
      (previous.kind === "agent_message" && current.kind === "message")
    );
  }

  return false;
}

function parseJsonlSession(filePath: string, archived: boolean): ParsedSessionFile | null {
  const fileName = basename(filePath);
  const fallbackThreadId = extractFallbackThreadId(fileName);
  const lines = readFileSync(filePath, "utf8").split("\n");

  let seq = 0;
  let threadId = fallbackThreadId;
  const messages: MessageRecord[] = [];
  const meta: ParsedSessionFile["meta"] = {
    threadId,
    sourceFile: filePath,
    sourceKind: archived ? "archived" : "session",
    fileExists: 1,
    archived: archived ? 1 : 0,
  };
  let previousMessage: Pick<MessageRecord, "role" | "kind" | "text"> | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
      const payload = parsed.payload as Record<string, unknown>;
      threadId = firstString(payload.id) ?? threadId;
      meta.threadId = threadId;
      meta.cwd = firstString(payload.cwd);
      meta.source = firstString(payload.source);
      meta.modelProvider = firstString(payload.model_provider);
      meta.cliVersion = firstString(payload.cli_version);
      meta.archived = archived ? 1 : 0;
      meta.title =
        firstString(payload.thread_name, payload.title) ??
        (meta.title ?? null);
      continue;
    }

    let role: MessageRecord["role"] | null = null;
    let text: string | null = null;
    let kind = String(parsed.type ?? "unknown");
    let phase: string | null = null;
    let messageRef = `${threadId}:${index + 1}`;

    if (parsed.type === "event_msg" && parsed.payload && typeof parsed.payload === "object") {
      const payload = parsed.payload as Record<string, unknown>;
      kind = firstString(payload.type) ?? kind;
      phase = firstString(payload.phase);
      if (payload.type === "user_message") {
        role = "user";
        text = readTextValue(payload.message) ?? readTextValue(payload.text);
      } else if (payload.type === "agent_message") {
        role = "assistant";
        text = readTextValue(payload.message) ?? readTextValue(payload.text);
      }
    } else if (
      parsed.type === "response_item" &&
      parsed.payload &&
      typeof parsed.payload === "object"
    ) {
      const payload = parsed.payload as Record<string, unknown>;
      kind = firstString(payload.type) ?? kind;
      if (payload.type === "message") {
        role = inferRole(payload.role);
        text = collectResponseMessageText(payload);
        if (role !== "user" && role !== "assistant") {
          role = null;
        }
      }
    }

    if (!role || !text || text.trim().length === 0) {
      continue;
    }

    if (isStructuralDuplicate(previousMessage, { role, kind, text })) {
      continue;
    }

    seq += 1;
    messageRef = `${threadId}:${seq}`;
    const nextMessage = {
      threadId,
      seq,
      messageRef,
      role,
      kind,
      phase,
      text,
      createdAt: firstString(parsed.timestamp),
      sourceFile: filePath,
      sourceLine: index + 1,
    } satisfies MessageRecord;
    messages.push(nextMessage);
    previousMessage = nextMessage;
  }

  if (!threadId && messages.length === 0) {
    return null;
  }

  return {
    threadId,
    meta,
    messages,
  };
}

function initializeIndexSchema(db: SqlDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
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
    );
    CREATE TABLE IF NOT EXISTS messages (
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
    );
    CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_provider ON threads(model_provider);
    CREATE INDEX IF NOT EXISTS idx_threads_cwd ON threads(cwd);
    CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
  `);
}

function resetIndex(db: SqlDatabase): void {
  db.exec(`
    DELETE FROM meta;
    DELETE FROM messages;
    DELETE FROM sqlite_sequence WHERE name = 'messages';
    DELETE FROM threads;
  `);
}

export interface RebuildIndexStats {
  builtAt: string;
  threadCount: number;
  messageCount: number;
  activeSessionFileCount: number;
  archivedSessionFileCount: number;
}

function rebuildIndexUnlocked(paths: ResolvedPaths): RebuildIndexStats {
  ensureParentDirectory(paths.indexDb);

  const threadMap = readStateThreads(paths.stateDb);
  const activeSessionFiles = walkJsonlFiles(paths.sessionsDir);
  const archivedSessionFiles = walkJsonlFiles(paths.archivedSessionsDir);
  const allSessions = [
    ...activeSessionFiles.map((filePath) => ({ filePath, archived: false })),
    ...archivedSessionFiles.map((filePath) => ({ filePath, archived: true })),
  ];

  const parsedSessions: ParsedSessionFile[] = [];
  for (const entry of allSessions) {
    const parsed = parseJsonlSession(entry.filePath, entry.archived);
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
      stateTitle: existing.title,
      sessionTitle: parsed.meta.title ?? null,
      firstUserMessage: firstMeaningfulUser?.text ?? existing.firstUserMessage,
    });

    existing.messageCount = parsed.messages.length;
    existing.userMessageCount = parsed.messages.filter((message) => message.role === "user").length;
    existing.assistantMessageCount = parsed.messages.filter(
      (message) => message.role === "assistant",
    ).length;
    existing.lastMessageAt =
      parsed.messages[parsed.messages.length - 1]?.createdAt ?? existing.lastMessageAt;
    if (!existing.rolloutPath && parsed.meta.sourceFile) {
      existing.rolloutPath = parsed.meta.sourceFile;
    }

    threadMap.set(parsed.threadId, existing);
  }

  const db = openDatabase(paths.indexDb);
  try {
    initializeIndexSchema(db);

    const insertThread = db.query(`
      INSERT INTO threads (
        thread_id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        archived,
        archived_at,
        git_sha,
        git_branch,
        git_origin_url,
        cli_version,
        first_user_message,
        agent_nickname,
        agent_role,
        memory_mode,
        model,
        reasoning_effort,
        agent_path,
        source_file,
        source_kind,
        file_exists,
        message_count,
        user_message_count,
        assistant_message_count,
        last_message_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const insertMessage = db.query(`
      INSERT INTO messages (
        thread_id,
        seq,
        message_ref,
        role,
        kind,
        phase,
        text,
        created_at,
        source_file,
        source_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMeta = db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`);

    let messageCount = 0;
    const builtAt = new Date().toISOString();

    const writeTransaction = db.transaction(() => {
      resetIndex(db);

      for (const thread of threadMap.values()) {
        insertThread.run(
          thread.threadId,
          thread.rolloutPath,
          thread.createdAt,
          thread.updatedAt,
          thread.source,
          thread.modelProvider,
          thread.cwd,
          thread.title,
          thread.sandboxPolicy,
          thread.approvalMode,
          thread.tokensUsed,
          thread.archived,
          thread.archivedAt,
          thread.gitSha,
          thread.gitBranch,
          thread.gitOriginUrl,
          thread.cliVersion,
          thread.firstUserMessage,
          thread.agentNickname,
          thread.agentRole,
          thread.memoryMode,
          thread.model,
          thread.reasoningEffort,
          thread.agentPath,
          thread.sourceFile,
          thread.sourceKind,
          thread.fileExists,
          thread.messageCount,
          thread.userMessageCount,
          thread.assistantMessageCount,
          thread.lastMessageAt,
        );
      }

      for (const session of parsedSessions) {
        for (const message of session.messages) {
          insertMessage.run(
            message.threadId,
            message.seq,
            message.messageRef,
            message.role,
            message.kind,
            message.phase,
            message.text,
            message.createdAt,
            message.sourceFile,
            message.sourceLine,
          );
          messageCount += 1;
        }
      }

      insertMeta.run("built_at", builtAt);
      insertMeta.run("thread_count", String(threadMap.size));
      insertMeta.run("message_count", String(messageCount));
      insertMeta.run("active_session_file_count", String(activeSessionFiles.length));
      insertMeta.run("archived_session_file_count", String(archivedSessionFiles.length));
      insertMeta.run("source_state_db_path", paths.stateDb);
      insertMeta.run("source_id", paths.sourceId);
      insertMeta.run("source_kind", paths.sourceKind);
      insertMeta.run("source_root", paths.sourceRoot);
    });

    writeTransaction();

    return {
      builtAt,
      threadCount: threadMap.size,
      messageCount,
      activeSessionFileCount: activeSessionFiles.length,
      archivedSessionFileCount: archivedSessionFiles.length,
    };
  } finally {
    db.close();
  }
}

export function rebuildIndex(paths: ResolvedPaths): RebuildIndexStats {
  return withIndexBuildLock(paths, () => rebuildIndexUnlocked(paths));
}

export function ensureIndex(paths: ResolvedPaths, refresh: boolean): void {
  if (!refresh && isIndexReady(paths)) {
    return;
  }

  while (hasActiveIndexLock(paths)) {
    sleepSync(INDEX_LOCK_POLL_MS);
  }

  withIndexBuildLock(paths, () => {
    if (!refresh && isIndexReady(paths)) {
      return;
    }
    rebuildIndexUnlocked(paths);
  });
}

function getMetaMap(db: SqlDatabase): Record<string, string> {
  const rows = all<{ key: string; value: string }>(db, `SELECT key, value FROM meta`);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function runReadonlyQuery(db: SqlDatabase, sql: string): Array<Record<string, unknown>> {
  return all<Record<string, unknown>>(db, sql);
}

function stripSqlStringsAndComments(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      result += " ";
      index += 1;
      while (index < sql.length) {
        const current = sql[index]!;
        if (current === quote) {
          if (quote === "'" && sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "[" ) {
      result += " ";
      index += 1;
      while (index < sql.length && sql[index] !== "]") {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      result += " ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      result += " ";
      index += 2;
      while (index + 1 < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) {
    throw new Error("A SQL query is required.");
  }

  const stripped = stripSqlStringsAndComments(trimmed);
  if (/;(?=\s*\S)/.test(stripped)) {
    throw new Error("Only a single read-only query is allowed.");
  }

  const normalized = stripped.trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("Only read-only SELECT and WITH queries are allowed.");
  }

  if (
    /\b(insert|update|delete|replace|create|drop|alter|truncate|attach|detach|vacuum|pragma|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i.test(
      normalized,
    )
  ) {
    throw new Error("Only read-only SELECT and WITH queries are allowed.");
  }

  return trimmed;
}

export function readIndexMeta(paths: ResolvedPaths): Record<string, string> {
  if (!existsSync(paths.indexDb)) {
    return {};
  }
  const db = openDatabase(paths.indexDb);
  try {
    return getMetaMap(db);
  } finally {
    db.close();
  }
}

export function listThreads(
  paths: ResolvedPaths,
  options: {
    provider?: string;
    cwd?: string;
    limit: number;
  },
): Array<Record<string, unknown>> {
  const db = openDatabase(paths.indexDb);
  try {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.provider) {
      where.push("model_provider = ?");
      params.push(options.provider);
    }
    if (options.cwd) {
      where.push("cwd = ?");
      params.push(options.cwd);
    }

    const sql = `
      SELECT
        thread_id,
        title,
        model_provider,
        cwd,
        updated_at,
        archived,
        source_kind,
        message_count,
        user_message_count,
        assistant_message_count,
        last_message_at
      FROM threads
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC NULLS LAST, thread_id DESC
      LIMIT ?
    `;
    params.push(options.limit);
    return all<Record<string, unknown>>(db, sql, ...params);
  } finally {
    db.close();
  }
}

function containsTextExpression(columnName: string): string {
  return `(instr(${columnName}, ?) > 0 OR instr(lower(${columnName}), lower(?)) > 0)`;
}

export function searchMessages(
  paths: ResolvedPaths,
  options: {
    query: string;
    threadId?: string;
    role?: string;
    limit: number;
  },
): Array<Record<string, unknown>> {
  const db = openDatabase(paths.indexDb);
  try {
    const where = [containsTextExpression("text")];
    const params: Array<string | number> = [options.query, options.query];
    if (options.threadId) {
      where.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.role) {
      where.push("role = ?");
      params.push(options.role);
    }

    params.push(Math.max(options.limit * 5, options.limit));
    const rows = all<Record<string, unknown>>(
      db,
      `
          SELECT thread_id, seq, message_ref, role, kind, phase, text, created_at
          FROM messages
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC NULLS LAST, message_pk DESC
          LIMIT ?
        `,
      ...params,
    );

    return rows
      .map((row) => {
        const text = String(row.text ?? "");
        return {
          thread_id: row.thread_id,
          seq: row.seq,
          message_ref: row.message_ref,
          role: row.role,
          kind: row.kind,
          phase: row.phase,
          text_snippet: buildSnippet(text, options.query),
          created_at: row.created_at,
          noisy_match: isNoisyText(text) ? 1 : 0,
        };
      })
      .sort((left, right) => {
        const noisyDelta = Number(left.noisy_match) - Number(right.noisy_match);
        if (noisyDelta !== 0) {
          return noisyDelta;
        }
        const leftCreatedAt = typeof left.created_at === "string" ? Date.parse(left.created_at) : 0;
        const rightCreatedAt = typeof right.created_at === "string" ? Date.parse(right.created_at) : 0;
        return rightCreatedAt - leftCreatedAt;
      })
      .slice(0, options.limit);
  } finally {
    db.close();
  }
}

export function searchThreads(
  paths: ResolvedPaths,
  options: {
    query: string;
    provider?: string;
    cwd?: string;
    limit: number;
  },
): Array<Record<string, unknown>> {
  const db = openDatabase(paths.indexDb);
  try {
    const result = new Map<string, Record<string, unknown>>();

    const threadWhere = [
      `(${containsTextExpression("title")} OR ${containsTextExpression("COALESCE(first_user_message, '')")})`,
      "1 = 1",
    ];
    const threadParams: Array<string | number> = [
      options.query,
      options.query,
      options.query,
      options.query,
    ];
    if (options.provider) {
      threadWhere.push("model_provider = ?");
      threadParams.push(options.provider);
    }
    if (options.cwd) {
      threadWhere.push("cwd = ?");
      threadParams.push(options.cwd);
    }

    const titleMatches = all<Record<string, unknown>>(
      db,
      `
          SELECT
            thread_id,
            title,
            model_provider,
            cwd,
            updated_at,
            archived,
            source_kind,
            message_count,
            user_message_count,
            assistant_message_count,
            last_message_at,
            first_user_message
          FROM threads
          WHERE ${threadWhere.join(" AND ")}
          ORDER BY updated_at DESC NULLS LAST
          LIMIT ?
        `,
      ...threadParams,
      options.limit * 2,
    );

    for (const thread of titleMatches) {
      const title = typeof thread.title === "string" ? thread.title : null;
      const firstUserMessage =
        typeof thread.first_user_message === "string" ? thread.first_user_message : null;
      result.set(String(thread.thread_id), {
        thread_id: thread.thread_id,
        title,
        model_provider: thread.model_provider,
        cwd: thread.cwd,
        updated_at: thread.updated_at,
        archived: thread.archived,
        source_kind: thread.source_kind,
        message_count: thread.message_count,
        user_message_count: thread.user_message_count,
        assistant_message_count: thread.assistant_message_count,
        last_message_at: thread.last_message_at,
        title_match: 1,
        message_hit_count: 0,
        message_snippet: null,
        noisy_match: isNoisyText(title) || isNoisyText(firstUserMessage) ? 1 : 0,
      });
    }

    const messageWhere = [containsTextExpression("m.text")];
    const messageParams: Array<string | number> = [options.query, options.query];
    if (options.provider) {
      messageWhere.push("t.model_provider = ?");
      messageParams.push(options.provider);
    }
    if (options.cwd) {
      messageWhere.push("t.cwd = ?");
      messageParams.push(options.cwd);
    }

    const messageMatches = all<Record<string, unknown>>(
      db,
      `
          SELECT
            t.thread_id,
            t.title,
            t.model_provider,
            t.cwd,
            t.updated_at,
            t.archived,
            t.source_kind,
            t.message_count,
            t.user_message_count,
            t.assistant_message_count,
            t.last_message_at,
            t.first_user_message,
            COUNT(*) AS message_hit_count,
            MIN(m.text) AS matched_text
          FROM messages m
          JOIN threads t ON t.thread_id = m.thread_id
          WHERE ${messageWhere.join(" AND ")}
          GROUP BY t.thread_id
          ORDER BY message_hit_count DESC, t.updated_at DESC NULLS LAST
          LIMIT ?
        `,
      ...messageParams,
      options.limit * 3,
    );

    for (const thread of messageMatches) {
      const threadId = String(thread.thread_id);
      const current = result.get(threadId);
      const title = typeof thread.title === "string" ? thread.title : null;
      const firstUserMessage =
        typeof thread.first_user_message === "string" ? thread.first_user_message : null;
      const matchedText = typeof thread.matched_text === "string" ? thread.matched_text : null;
      result.set(threadId, {
        ...(current ?? {
          thread_id: thread.thread_id,
          title,
          model_provider: thread.model_provider,
          cwd: thread.cwd,
          updated_at: thread.updated_at,
          archived: thread.archived,
          source_kind: thread.source_kind,
          message_count: thread.message_count,
          user_message_count: thread.user_message_count,
          assistant_message_count: thread.assistant_message_count,
          last_message_at: thread.last_message_at,
          title_match: 0,
          message_hit_count: 0,
          message_snippet: null,
          noisy_match: 0,
        }),
        title,
        model_provider: thread.model_provider,
        cwd: thread.cwd,
        updated_at: thread.updated_at,
        archived: thread.archived,
        source_kind: thread.source_kind,
        message_count: thread.message_count,
        user_message_count: thread.user_message_count,
        assistant_message_count: thread.assistant_message_count,
        last_message_at: thread.last_message_at,
        title_match: Number((current?.title_match as number | undefined) ?? 0),
        message_hit_count: Number(thread.message_hit_count ?? 0),
        message_snippet: matchedText ? buildSnippet(matchedText, options.query) : null,
        noisy_match:
          isNoisyText(title) || isNoisyText(firstUserMessage) || isNoisyText(matchedText) ? 1 : 0,
      });
    }

    return Array.from(result.values())
      .sort((left, right) => {
        const noisyDelta = Number(left.noisy_match ?? 0) - Number(right.noisy_match ?? 0);
        if (noisyDelta !== 0) {
          return noisyDelta;
        }
        const titleDelta = Number(right.title_match ?? 0) - Number(left.title_match ?? 0);
        if (titleDelta !== 0) {
          return titleDelta;
        }
        const hitDelta = Number(right.message_hit_count ?? 0) - Number(left.message_hit_count ?? 0);
        if (hitDelta !== 0) {
          return hitDelta;
        }
        return Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0);
      })
      .slice(0, options.limit);
  } finally {
    db.close();
  }
}

export function getThread(paths: ResolvedPaths, threadId: string): Record<string, unknown> | null {
  const db = openDatabase(paths.indexDb);
  try {
    return get<Record<string, unknown>>(db, `SELECT * FROM threads WHERE thread_id = ?`, threadId);
  } finally {
    db.close();
  }
}

export function getThreadMessages(
  paths: ResolvedPaths,
  threadId: string,
): Array<Record<string, unknown>> {
  const db = openDatabase(paths.indexDb);
  try {
    return all<Record<string, unknown>>(
      db,
      `
          SELECT thread_id, seq, message_ref, role, kind, phase, text, created_at, source_file, source_line
          FROM messages
          WHERE thread_id = ?
          ORDER BY seq ASC
        `,
      threadId,
    );
  } finally {
    db.close();
  }
}

export function getMessageContext(
  paths: ResolvedPaths,
  input: {
    threadId: string;
    messageSelector: string;
    before: number;
    after: number;
  },
): {
  anchor: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
} | null {
  const db = openDatabase(paths.indexDb);
  try {
    const anchor =
      /^\d+$/.test(input.messageSelector)
        ? get<Record<string, unknown>>(
            db,
            `SELECT * FROM messages WHERE thread_id = ? AND seq = ?`,
            input.threadId,
            Number(input.messageSelector),
          )
        : get<Record<string, unknown>>(
            db,
            `SELECT * FROM messages WHERE thread_id = ? AND message_ref = ?`,
            input.threadId,
            input.messageSelector,
          );

    if (!anchor) {
      return null;
    }

    const seq = Number(anchor.seq);
    const messages = all<Record<string, unknown>>(
      db,
      `
          SELECT thread_id, seq, message_ref, role, kind, phase, text, created_at
          FROM messages
          WHERE thread_id = ? AND seq BETWEEN ? AND ?
          ORDER BY seq ASC
        `,
      input.threadId,
      Math.max(1, seq - input.before),
      seq + input.after,
    );

    return { anchor, messages };
  } finally {
    db.close();
  }
}

export function getThreadStats(paths: ResolvedPaths): Record<string, unknown> {
  const db = openDatabase(paths.indexDb);
  try {
    const totals = get<Record<string, unknown>>(
      db,
      `
          SELECT
            COUNT(*) AS thread_count,
            SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_count,
            COALESCE(SUM(message_count), 0) AS message_count
          FROM threads
        `,
    ) ?? {};

    const providers = all<Record<string, unknown>>(
      db,
      `
          SELECT model_provider, COUNT(*) AS count
          FROM threads
          GROUP BY model_provider
          ORDER BY count DESC, model_provider ASC
        `,
    );

    const topCwds = all<Record<string, unknown>>(
      db,
      `
          SELECT cwd, COUNT(*) AS count
          FROM threads
          GROUP BY cwd
          ORDER BY count DESC, cwd ASC
          LIMIT 10
        `,
    );

    return {
      ...totals,
      providers,
      topCwds,
      meta: getMetaMap(db),
    };
  } finally {
    db.close();
  }
}

export function getRelatedThreads(
  paths: ResolvedPaths,
  threadId: string,
  limit: number,
): Array<Record<string, unknown>> {
  const db = openDatabase(paths.indexDb);
  try {
    const target = get<Record<string, unknown>>(db, `SELECT * FROM threads WHERE thread_id = ?`, threadId);
    if (!target) {
      return [];
    }

    const cwd = firstString(target.cwd);
    if (cwd) {
      return all<Record<string, unknown>>(
        db,
        `
            SELECT thread_id, title, cwd, model_provider, updated_at
            FROM threads
            WHERE thread_id != ? AND cwd = ?
            ORDER BY updated_at DESC NULLS LAST
            LIMIT ?
          `,
        threadId,
        cwd,
        limit,
      );
    }

    return all<Record<string, unknown>>(
      db,
      `
          SELECT thread_id, title, cwd, model_provider, updated_at
          FROM threads
          WHERE thread_id != ?
          ORDER BY updated_at DESC NULLS LAST
          LIMIT ?
        `,
      threadId,
      limit,
    );
  } finally {
    db.close();
  }
}

export function runReadOnlySql(
  paths: ResolvedPaths,
  sql: string,
): Array<Record<string, unknown>> {
  const trimmed = assertReadOnlySql(sql);

  const db = openDatabase(paths.indexDb);
  try {
    return runReadonlyQuery(db, trimmed);
  } finally {
    db.close();
  }
}

export function readRawJsonl(
  paths: ResolvedPaths,
  threadId: string,
): {
  path: string;
  contents: string;
} | null {
  const thread = getThread(paths, threadId);
  const sourceFile = firstString(thread?.source_file, thread?.rollout_path);
  if (!sourceFile || !existsSync(sourceFile)) {
    return null;
  }

  return {
    path: sourceFile,
    contents: readFileSync(sourceFile, "utf8"),
  };
}
