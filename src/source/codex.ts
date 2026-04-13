import { basename } from "node:path";
import { Effect } from "effect";

import type { CliFailure } from "../errors.ts";
import { fileExists, readDirectory, readFileString } from "../infra/fs.ts";
import { all, withDatabase } from "../infra/sqlite.ts";
import type { MessageRecord, ParsedSessionFile, ThreadRecord } from "../types.ts";

const ROLLOUT_THREAD_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const NOISY_TITLE_PATTERNS = [
  "The following is the Codex agent history",
  "The Codex agent has requested the following action",
  ">>> TRANSCRIPT START",
  "tool exec_command call:",
  "tool exec_command result:",
];

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

function looksNoisyTitle(title: string | null): boolean {
  if (!title) {
    return false;
  }

  if (title.length > 1_500 || title.includes("[1] user:")) {
    return true;
  }

  return NOISY_TITLE_PATTERNS.some((pattern) => title.includes(pattern));
}

function extractFallbackThreadId(fileName: string): string {
  const matchedId = fileName.match(ROLLOUT_THREAD_ID_PATTERN)?.[1];
  if (matchedId) {
    return matchedId;
  }

  return fileName.replace(/\.jsonl$/i, "").replace(/^rollout-/, "");
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

function readEpochMilliseconds(value: unknown): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : null;

  if (numericValue === null || !Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue < 1_000_000_000_000 ? numericValue * 1_000 : numericValue;
}

type ParsedMessageDraft = Omit<MessageRecord, "threadId" | "messageRef">;

export function chooseThreadTitle(input: {
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

export function walkJsonlFiles(root: string): Effect.Effect<string[], CliFailure> {
  return Effect.gen(function* () {
    const exists = yield* fileExists(root);
    if (!exists) {
      return [];
    }

    const result: string[] = [];
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const entries = yield* readDirectory(current);
      for (const entry of entries) {
        const fullPath = `${current}/${entry}`;
        const childExists = yield* fileExists(fullPath);
        if (!childExists) {
          continue;
        }
        if (fullPath.endsWith(".jsonl")) {
          result.push(fullPath);
          continue;
        }

        const nested = yield* readDirectory(fullPath).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        );
        if (nested) {
          stack.push(fullPath);
        }
      }
    }

    result.sort((left, right) => left.localeCompare(right));
    return result;
  });
}

export function readStateThreads(stateDbPath: string): Effect.Effect<Map<string, ThreadRecord>, CliFailure> {
  const threads = new Map<string, ThreadRecord>();
  return fileExists(stateDbPath).pipe(
    Effect.flatMap((exists) =>
      !exists
        ? Effect.succeed(threads)
        : withDatabase(stateDbPath, (db) =>
            Effect.gen(function* () {
    const rows = yield* all<Record<string, unknown>>(
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
        createdAt: readEpochMilliseconds(row.created_at),
        updatedAt: readEpochMilliseconds(row.updated_at),
        source: (row.source as string | null) ?? null,
        modelProvider: (row.model_provider as string | null) ?? null,
        cwd: (row.cwd as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        sandboxPolicy: (row.sandbox_policy as string | null) ?? null,
        approvalMode: (row.approval_mode as string | null) ?? null,
        tokensUsed: typeof row.tokens_used === "number" ? row.tokens_used : null,
        archived: Number(row.archived ?? 0),
        archivedAt: readEpochMilliseconds(row.archived_at),
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
        fileExists: row.rollout_path ? 1 : 0,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        lastMessageAt: null,
      });
    }
    return threads;
            }),
          ),
    ),
  );
}

export function parseJsonlSession(filePath: string, archived: boolean): Effect.Effect<ParsedSessionFile | null, CliFailure> {
  return Effect.gen(function* () {
    const fileName = basename(filePath);
    const fallbackThreadId = extractFallbackThreadId(fileName);
    const lines = (yield* readFileString(filePath)).split("\n");

    let seq = 0;
    let threadId = fallbackThreadId;
    const messageDrafts: ParsedMessageDraft[] = [];
    const meta: ParsedSessionFile["meta"] = {
      threadId,
      sourceFile: filePath,
      sourceKind: archived ? "archived" : "session",
      fileExists: 1,
      archived: archived ? 1 : 0,
    };
    let previousMessage: Pick<MessageRecord, "role" | "kind" | "text"> | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] ?? "").trim();
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
        meta.title = firstString(payload.thread_name, payload.title) ?? (meta.title ?? null);
        continue;
      }

      let role: MessageRecord["role"] | null = null;
      let text: string | null = null;
      let kind = String(parsed.type ?? "unknown");
      let phase: string | null = null;

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
      const nextMessage = {
        seq,
        role,
        kind,
        phase,
        text,
        createdAt: firstString(parsed.timestamp),
        sourceFile: filePath,
        sourceLine: index + 1,
      } satisfies ParsedMessageDraft;
      messageDrafts.push(nextMessage);
      previousMessage = nextMessage;
    }

    if (!threadId && messageDrafts.length === 0) {
      return null;
    }

    const messages = messageDrafts.map((message) => ({
      ...message,
      threadId,
      messageRef: `${threadId}:${message.seq}`,
    })) satisfies MessageRecord[];

    return {
      threadId,
      meta,
      messages,
    };
  });
}

export function inferThreadIdFromSessionFile(filePath: string): Effect.Effect<string | null, CliFailure> {
  return Effect.gen(function* () {
    const fileName = basename(filePath);
    let threadId = extractFallbackThreadId(fileName);
    const lines = (yield* readFileString(filePath)).split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] ?? "").trim();
      if (line.length === 0) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        break;
      }

      if (parsed.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
        const payload = parsed.payload as Record<string, unknown>;
        threadId = firstString(payload.id) ?? threadId;
        break;
      }
    }

    return threadId || null;
  });
}

export function readRawJsonl(
  thread: Record<string, unknown> | null,
): Effect.Effect<{
  path: string;
  contents: string;
} | null> {
  return Effect.sync(() => {
    const sourceFile =
      typeof thread?.source_file === "string" && thread.source_file.length > 0
        ? thread.source_file
        : typeof thread?.rollout_path === "string" && thread.rollout_path.length > 0
          ? thread.rollout_path
          : null;
    if (!sourceFile) {
      return null;
    }
    return Effect.runSync(
      Effect.gen(function* () {
        const exists = yield* fileExists(sourceFile);
        if (!exists) {
          return null;
        }
        return {
          path: sourceFile,
          contents: yield* readFileString(sourceFile),
        };
      }),
    );
  });
}
