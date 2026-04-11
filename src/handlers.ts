import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";

import { resolvePaths, writeConfigFile } from "./config.ts";
import { CliFailure } from "./errors.ts";
import { renderThreadExportMarkdown } from "./output.ts";
import {
  ensureIndex,
  getMessageContext,
  getRelatedThreads,
  getThread,
  getThreadMessages,
  getThreadStats,
  listThreads,
  readIndexMeta,
  readRawJsonl,
  rebuildIndex,
  runReadOnlySql,
  searchMessages,
  searchThreads,
} from "./store.ts";
import type { GlobalOptions } from "./types.ts";

const LimitOptionsSchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
});

const ContextOptionsSchema = z.object({
  before: z.coerce.number().int().min(0).default(3),
  after: z.coerce.number().int().min(0).default(3),
});

const OpenMessagesOptionsSchema = z.object({
  full: z.coerce.boolean().optional().default(false),
  head: z.coerce.number().int().min(0).default(4),
  tail: z.coerce.number().int().min(0).default(4),
  maxChars: z.coerce.number().int().positive().default(4000),
});

export function ensureValue(value: string | number | undefined, label: string): string {
  if (value === undefined || value === null) {
    throw new CliFailure("missing-argument", `Missing ${label}.`);
  }
  const normalized = String(value).trim();
  if (normalized.length === 0) {
    throw new CliFailure("missing-argument", `Missing ${label}.`);
  }
  return normalized;
}

function slicePreviewMessages(messages: Array<Record<string, unknown>>) {
  if (messages.length <= 8) {
    return messages;
  }
  return [...messages.slice(0, 4), ...messages.slice(-4)];
}

function countJsonlFiles(root: string): number {
  if (!existsSync(root)) {
    return 0;
  }

  let count = 0;
  for (const _ of new Bun.Glob("**/*.jsonl").scanSync({ cwd: root, absolute: true })) {
    count += 1;
  }
  return count;
}

function trimMessageText(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`,
    truncated: true,
  };
}

function buildOpenMessagesPayload(
  thread: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  rawOptions: Record<string, unknown>,
) {
  const options = OpenMessagesOptionsSchema.parse(rawOptions);
  if (options.full || messages.length <= options.head + options.tail) {
    return {
      thread,
      messages,
      truncated: false,
      returnedMessageCount: messages.length,
      omittedMessageCount: 0,
    };
  }

  const headMessages = messages.slice(0, options.head);
  const tailMessages = options.tail > 0 ? messages.slice(-options.tail) : [];
  const selected = [...headMessages, ...tailMessages].filter((message, index, array) => {
    if (index === 0) {
      return true;
    }
    return message.message_ref !== array[index - 1]?.message_ref;
  });

  let remainingChars = options.maxChars;
  const excerptMessages = selected.map((message) => {
    const budget = Math.max(120, Math.floor(remainingChars / Math.max(1, selected.length)));
    const trimmed = trimMessageText(message.text, budget);
    remainingChars = Math.max(0, remainingChars - trimmed.text.length);
    return {
      ...message,
      text: trimmed.text,
    };
  });

  return {
    thread,
    messages: excerptMessages,
    truncated: true,
    returnedMessageCount: excerptMessages.length,
    omittedMessageCount: Math.max(0, messages.length - excerptMessages.length),
  };
}

export async function handleDoctor(options: GlobalOptions) {
  const paths = resolvePaths(options);
  if (options.refresh) {
    ensureIndex(paths, true);
  }
  const indexMeta = readIndexMeta(paths);
  const stateDbExists = existsSync(paths.stateDb);
  const logsDbExists = existsSync(paths.logsDb);
  const sessionIndexExists = existsSync(paths.sessionIndex);
  const sessionsDirExists = existsSync(paths.sessionsDir);
  const archivedSessionsDirExists = existsSync(paths.archivedSessionsDir);
  const indexExists = existsSync(paths.indexDb);

  return {
    sourceId: paths.sourceId,
    sourceKind: paths.sourceKind,
    sourceRoot: paths.sourceRoot,
    stateDb: paths.stateDb,
    stateDbExists,
    logsDb: paths.logsDb,
    logsDbExists,
    sessionIndex: paths.sessionIndex,
    sessionIndexExists,
    sessionsDir: paths.sessionsDir,
    sessionsDirExists,
    archivedSessionsDir: paths.archivedSessionsDir,
    archivedSessionsDirExists,
    sessionFileCount: sessionsDirExists ? countJsonlFiles(paths.sessionsDir) : 0,
    archivedSessionFileCount: archivedSessionsDirExists ? countJsonlFiles(paths.archivedSessionsDir) : 0,
    indexDb: paths.indexDb,
    indexExists,
    indexBuiltAt: indexMeta.built_at ?? null,
    indexThreadCount: Number(indexMeta.thread_count ?? 0),
    indexMessageCount: Number(indexMeta.message_count ?? 0),
    configSourceRoot: paths.configSource.sourceRoot,
    configSourceSelection: paths.configSource.sourceSelection,
    configSourceIndexDb: paths.configSource.indexDb,
    authRequired: false,
    mode: "offline-local",
  };
}

export async function handleInit(options: GlobalOptions) {
  const resolved = resolvePaths(options);
  writeConfigFile(resolved, {
    ...(options.source ? { sourceId: options.source } : {}),
    ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
    ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}),
    ...(options.indexDb ? { indexDb: options.indexDb } : {}),
  });
  return {
    configFile: resolved.configFile,
    sourceId: options.source ?? resolved.sourceId,
    sourceKind: options.sourceKind ?? resolved.sourceKind,
    sourceRoot: options.sourceRoot ?? resolved.sourceRoot,
    indexDb: resolved.indexDb,
  };
}

export async function handleIndexAction(action: string, options: GlobalOptions) {
  if (action !== "rebuild") {
    throw new CliFailure("invalid-command", `Unknown index action: ${action}`);
  }
  return rebuildIndex(resolvePaths(options));
}

export async function handleThreadsAction(
  action: string,
  value: string | undefined,
  rawOptions: Record<string, unknown>,
  options: GlobalOptions,
) {
  const paths = resolvePaths(options);
  ensureIndex(paths, options.refresh);
  const { limit } = LimitOptionsSchema.parse(rawOptions);

  if (action === "list") {
    return listThreads(paths, {
      provider: rawOptions.provider as string | undefined,
      cwd: rawOptions.cwd as string | undefined,
      limit,
    });
  }

  if (action === "search") {
    return searchThreads(paths, {
      query: ensureValue(value, "search query"),
      provider: rawOptions.provider as string | undefined,
      cwd: rawOptions.cwd as string | undefined,
      limit,
    });
  }

  if (action === "get") {
    const threadId = ensureValue(value, "thread id");
    const thread = getThread(paths, threadId);
    if (!thread) {
      throw new CliFailure("thread-not-found", `Thread not found: ${threadId}`);
    }
    return thread;
  }

  if (action === "open") {
    const threadId = ensureValue(value, "thread id");
    const thread = getThread(paths, threadId);
    if (!thread) {
      throw new CliFailure("thread-not-found", `Thread not found: ${threadId}`);
    }

    const format = z.enum(["summary", "messages", "jsonl"]).parse(rawOptions.format ?? "summary");
    if (format === "messages") {
      return buildOpenMessagesPayload(thread, getThreadMessages(paths, threadId), rawOptions);
    }
    if (format === "jsonl") {
      const raw = readRawJsonl(paths, threadId);
      if (!raw) {
        throw new CliFailure("raw-not-found", `Raw JSONL not found for thread: ${threadId}`);
      }
      return { thread, path: raw.path, contents: raw.contents };
    }
    return {
      thread,
      previewMessages: slicePreviewMessages(getThreadMessages(paths, threadId)),
    };
  }

  if (action === "related") {
    return getRelatedThreads(paths, ensureValue(value, "thread id"), limit);
  }

  if (action === "stats") {
    return getThreadStats(paths);
  }

  throw new CliFailure("invalid-command", `Unknown threads action: ${action}`);
}

export async function handleMessagesAction(
  action: string,
  value: string | undefined,
  rawOptions: Record<string, unknown>,
  options: GlobalOptions,
) {
  const paths = resolvePaths(options);
  ensureIndex(paths, options.refresh);
  const { limit } = LimitOptionsSchema.parse(rawOptions);

  if (action === "search") {
    return searchMessages(paths, {
      query: ensureValue(value, "search query"),
      threadId: rawOptions.thread as string | undefined,
      role: rawOptions.role as string | undefined,
      limit,
    });
  }

  if (action === "context") {
    const { before, after } = ContextOptionsSchema.parse(rawOptions);
    const threadId = ensureValue(value, "thread id");
    const messageSelector = ensureValue(rawOptions.message as string | number | undefined, "--message selector");
    const context = getMessageContext(paths, {
      threadId,
      messageSelector,
      before,
      after,
    });
    if (!context) {
      throw new CliFailure(
        "message-not-found",
        `Message ${messageSelector} was not found in thread ${threadId}.`,
      );
    }
    return context;
  }

  throw new CliFailure("invalid-command", `Unknown messages action: ${action}`);
}

export async function handleExportAction(
  kind: string,
  threadId: string,
  rawOptions: Record<string, unknown>,
  options: GlobalOptions,
) {
  const paths = resolvePaths(options);
  ensureIndex(paths, options.refresh);

  if (kind !== "thread") {
    throw new CliFailure("invalid-command", `Unknown export kind: ${kind}`);
  }

  const thread = getThread(paths, threadId);
  if (!thread) {
    throw new CliFailure("thread-not-found", `Thread not found: ${threadId}`);
  }

  const format = z.enum(["md", "json"]).parse(rawOptions.format ?? "md");
  const messages = getThreadMessages(paths, threadId);
  const contents =
    format === "json"
      ? JSON.stringify({ thread, messages }, null, 2)
      : renderThreadExportMarkdown(thread, messages);

  const outPath = rawOptions.out as string | undefined;
  if (outPath) {
    await mkdir(basename(outPath) === outPath ? "." : dirname(outPath), {
      recursive: true,
    });
    await writeFile(outPath, `${contents}\n`, "utf8");
    return {
      threadId,
      format,
      out: outPath,
      bytes: Buffer.byteLength(contents, "utf8"),
    };
  }

  return {
    threadId,
    format,
    contents,
  };
}

export async function handleRequestAction(
  kind: string,
  payload: string | undefined,
  options: GlobalOptions,
) {
  const paths = resolvePaths(options);
  ensureIndex(paths, options.refresh);

  if (kind !== "sql") {
    throw new CliFailure("invalid-command", `Unknown request kind: ${kind}`);
  }

  return runReadOnlySql(paths, ensureValue(payload, "SQL query"));
}
