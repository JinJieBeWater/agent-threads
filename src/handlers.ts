import { Effect } from "effect";

import { resolvePaths, writeConfigFile } from "./config.ts";
import { CliFailure } from "./errors.ts";
import { exportThreadData, readRawJsonl } from "./export.ts";
import { fileExists } from "./infra/fs.ts";
import { ensureIndex, readIndexMeta, rebuildIndex } from "./indexer.ts";
import { getMessageContext, searchMessages } from "./messages.ts";
import { runReadOnlySql } from "./request.ts";
import { getRelatedThreads, getThread, getThreadMessages, getThreadStats, listThreads, searchThreads } from "./threads.ts";
import type {
  ExportActionOptions,
  FindActionOptions,
  GlobalOptions,
  OpenActionOptions,
  RecentActionOptions,
  ResolvedPaths,
} from "./types.ts";

interface OpenExcerptOptions {
  full: boolean;
  head: number;
  tail: number;
  maxChars: number;
}

export function ensureValue(value: string | number | undefined, label: string): Effect.Effect<string, CliFailure> {
  return Effect.sync(() => {
    if (value === undefined || value === null) {
      throw new CliFailure({ code: "missing-argument", message: `Missing ${label}.` });
    }
    const normalized = String(value).trim();
    if (normalized.length === 0) {
      throw new CliFailure({ code: "missing-argument", message: `Missing ${label}.` });
    }
    return normalized;
  });
}

function slicePreviewMessages(messages: Array<Record<string, unknown>>) {
  if (messages.length <= 8) {
    return messages;
  }
  return [...messages.slice(0, 4), ...messages.slice(-4)];
}

function countJsonlFiles(root: string): Effect.Effect<number, CliFailure> {
  return Effect.gen(function* () {
    const exists = yield* fileExists(root);
    if (!exists) {
      return 0;
    }

    let count = 0;
    for (const _ of new Bun.Glob("**/*.jsonl").scanSync({ cwd: root, absolute: true })) {
      count += 1;
    }
    return count;
  });
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
  options: OpenExcerptOptions,
) {
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

function withResolvedPaths<A>(
  options: GlobalOptions,
  callback: (paths: ResolvedPaths) => Effect.Effect<A, CliFailure>,
): Effect.Effect<A, CliFailure> {
  return resolvePaths(options).pipe(Effect.flatMap(callback));
}

function withReadyIndex<A>(
  options: GlobalOptions,
  callback: (paths: ResolvedPaths) => Effect.Effect<A, CliFailure>,
): Effect.Effect<A, CliFailure> {
  return withResolvedPaths(options, (paths) =>
    ensureIndex(paths, options.refresh).pipe(Effect.flatMap(() => callback(paths))),
  );
}

function fail(code: string, message: string): Effect.Effect<never, CliFailure> {
  return Effect.fail(new CliFailure({ code, message }));
}

function getExistingThread(
  paths: ResolvedPaths,
  threadId: string,
): Effect.Effect<Record<string, unknown>, CliFailure> {
  return getThread(paths, threadId).pipe(
    Effect.flatMap((thread) => thread ? Effect.succeed(thread) : fail("thread-not-found", `Thread not found: ${threadId}`)),
  );
}

function parseTimeFilter(value: string | undefined, label: string): Effect.Effect<number | undefined, CliFailure> {
  return Effect.sync(() => {
    if (!value) {
      return undefined;
    }

    const relativeMatch = /^(\d+)([mhdw])$/i.exec(value.trim());
    if (relativeMatch) {
      const amount = Number(relativeMatch[1]);
      const unit = relativeMatch[2]?.toLowerCase();
      const unitMs = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
      return Date.now() - amount * unitMs;
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new CliFailure({ code: "invalid-argument", message: `Invalid ${label}.` });
    }
    return parsed;
  });
}

function formatIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value;
    return new Date(normalized).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        const normalized = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
        return new Date(normalized).toISOString();
      }
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return null;
}

function parseOpenTarget(target: string): { threadId: string; messageSelector?: string } {
  const normalized = target.startsWith("thread:") ? target.slice("thread:".length) : target;
  const messageRefIndex = normalized.indexOf("#");
  if (messageRefIndex >= 0) {
    return {
      threadId: normalized.slice(0, messageRefIndex),
      messageSelector: normalized.slice(messageRefIndex + 1),
    };
  }

  const seqMatch = /^(.*):(\d+)$/.exec(normalized);
  if (seqMatch) {
    const [, threadId, messageSelector] = seqMatch;
    return {
      threadId,
      messageSelector,
    };
  }

  return { threadId: normalized };
}

function buildFindThreadResult(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const threadId = String(row.thread_id);
  const whyMatched: string[] = [];
  if (Number(row.title_match ?? 0) > 0) {
    whyMatched.push("title");
  }
  if (Number(row.message_hit_count ?? 0) > 0) {
    whyMatched.push("message");
  }

  return {
    kind: "thread",
    target: `thread:${threadId}`,
    thread_id: threadId,
    title: row.title ?? null,
    snippet: row.message_snippet ?? row.title ?? null,
    updated_at: formatIsoTimestamp(row.updated_at),
    provider: row.model_provider ?? null,
    cwd: row.cwd ?? null,
    why_matched: whyMatched,
    _rank: 2_000 - index,
    _timestamp: typeof row.updated_at === "number" ? row.updated_at : 0,
    _noisy: Number(row.noisy_match ?? 0),
  };
}

function buildFindMessageResult(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const threadId = String(row.thread_id);
  const seq = Number(row.seq);
  const createdAt = formatIsoTimestamp(row.created_at);
  return {
    kind: "message",
    target: `thread:${threadId}:${seq}`,
    thread_id: threadId,
    seq,
    role: row.role ?? null,
    title: row.title ?? null,
    snippet: row.text_snippet ?? null,
    created_at: createdAt,
    provider: row.model_provider ?? null,
    cwd: row.cwd ?? null,
    why_matched: ["message"],
    _rank: 1_000 - index,
    _timestamp: createdAt ? Date.parse(createdAt) : 0,
    _noisy: Number(row.noisy_match ?? 0),
  };
}

function buildRecentThreadResult(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const threadId = String(row.thread_id);
  const firstUserMessage =
    typeof row.first_user_message === "string" && row.first_user_message.length > 0
      ? row.first_user_message
      : null;
  return {
    kind: "thread",
    target: `thread:${threadId}`,
    thread_id: threadId,
    title: row.title ?? null,
    first_user_message: firstUserMessage,
    updated_at: formatIsoTimestamp(row.updated_at),
    provider: row.model_provider ?? null,
    cwd: row.cwd ?? null,
    archived: row.archived ?? null,
    message_count: row.message_count ?? null,
    why_matched: ["recent"],
    _rank: 2_000 - index,
    _timestamp: typeof row.updated_at === "number" ? row.updated_at : 0,
    _noisy: 0,
  };
}

export function handleInspectSource(options: GlobalOptions): Effect.Effect<Record<string, unknown>, CliFailure> {
  return Effect.gen(function* () {
    const paths = yield* resolvePaths(options);
    if (options.refresh) {
      yield* ensureIndex(paths, true);
    }
    const indexMeta = yield* readIndexMeta(paths);
    const stateDbExists = yield* fileExists(paths.stateDb);
    const logsDbExists = yield* fileExists(paths.logsDb);
    const sessionIndexExists = yield* fileExists(paths.sessionIndex);
    const sessionsDirExists = yield* fileExists(paths.sessionsDir);
    const archivedSessionsDirExists = yield* fileExists(paths.archivedSessionsDir);
    const indexExists = yield* fileExists(paths.indexDb);

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
      sessionFileCount: sessionsDirExists ? yield* countJsonlFiles(paths.sessionsDir) : 0,
      archivedSessionFileCount: archivedSessionsDirExists ? yield* countJsonlFiles(paths.archivedSessionsDir) : 0,
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
  });
}

export function handleAdminInit(options: GlobalOptions): Effect.Effect<Record<string, unknown>, CliFailure> {
  return Effect.gen(function* () {
    const resolved = yield* resolvePaths(options);
    yield* writeConfigFile(resolved, {
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
  });
}

export function handleAdminReindex(options: GlobalOptions): Effect.Effect<unknown, CliFailure> {
  return withResolvedPaths(options, rebuildIndex);
}

export function handleExportAction(
  kind: string,
  threadId: string,
  actionOptions: ExportActionOptions,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  return withReadyIndex(options, (paths) =>
    Effect.gen(function* () {
      if (kind !== "thread") {
        return yield* fail("invalid-command", `Unknown export kind: ${kind}`);
      }

      const thread = yield* getExistingThread(paths, threadId);
      const messages = yield* getThreadMessages(paths, threadId);

      return yield* exportThreadData({
        threadId,
        format: actionOptions.format,
        thread,
        messages,
        outPath: actionOptions.out,
      });
    }),
  );
}

export function handleAdminSql(payload: string | undefined, options: GlobalOptions): Effect.Effect<unknown, CliFailure> {
  return withReadyIndex(options, (paths) =>
    Effect.gen(function* () {
      return yield* runReadOnlySql(paths, yield* ensureValue(payload, "SQL query"));
    }),
  );
}

export function handleFind(
  query: string | undefined,
  actionOptions: FindActionOptions,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  return withReadyIndex(options, (paths) =>
    Effect.gen(function* () {
      const searchQuery = yield* ensureValue(query, "search query");
      const sinceEpochMs = yield* parseTimeFilter(actionOptions.since, "--since");
      const untilEpochMs = yield* parseTimeFilter(actionOptions.until, "--until");
      const sinceIso = typeof sinceEpochMs === "number" ? new Date(sinceEpochMs).toISOString() : undefined;
      const untilIso = typeof untilEpochMs === "number" ? new Date(untilEpochMs).toISOString() : undefined;

      const threadRows =
        actionOptions.kind === "message"
          ? []
          : yield* searchThreads(paths, {
              query: searchQuery,
              provider: actionOptions.provider,
              cwd: actionOptions.cwd,
              limit: actionOptions.limit * 3,
              sinceEpochMs,
              untilEpochMs,
            });

      const messageRows =
        actionOptions.kind === "thread"
          ? []
          : yield* searchMessages(paths, {
              query: searchQuery,
              threadId: undefined,
              provider: actionOptions.provider,
              cwd: actionOptions.cwd,
              role: actionOptions.role,
              limit: actionOptions.limit * 3,
              sinceIso,
              untilIso,
            });

      const results = [
        ...threadRows.map(buildFindThreadResult),
        ...messageRows.map(buildFindMessageResult),
      ]
        .sort((left, right) => {
          const noisyDelta = Number(left._noisy ?? 0) - Number(right._noisy ?? 0);
          if (noisyDelta !== 0) {
            return noisyDelta;
          }
          const rankDelta = Number(right._rank ?? 0) - Number(left._rank ?? 0);
          if (rankDelta !== 0) {
            return rankDelta;
          }
          return Number(right._timestamp ?? 0) - Number(left._timestamp ?? 0);
        })
        .slice(0, actionOptions.limit)
        .map(({ _rank, _timestamp, _noisy, ...row }) => row);

      return {
        query: searchQuery,
        kind: actionOptions.kind,
        results,
      };
    }),
  );
}

export function handleRecent(
  actionOptions: RecentActionOptions,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  return withReadyIndex(options, (paths) =>
    Effect.gen(function* () {
      const sinceEpochMs = yield* parseTimeFilter(actionOptions.since, "--since");
      const untilEpochMs = yield* parseTimeFilter(actionOptions.until, "--until");

      const rows = yield* listThreads(paths, {
        provider: actionOptions.provider,
        cwd: actionOptions.cwd,
        limit: actionOptions.limit,
        sinceEpochMs,
        untilEpochMs,
      });

      return {
        results: rows.map(buildRecentThreadResult),
      };
    }),
  );
}

export function handleOpen(
  target: string | undefined,
  actionOptions: OpenActionOptions,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  return withReadyIndex(options, (paths) =>
    Effect.gen(function* () {
      const parsedTarget = parseOpenTarget(yield* ensureValue(target, "target"));

      if (parsedTarget.messageSelector) {
        const thread = yield* getExistingThread(paths, parsedTarget.threadId);
        const context = yield* getMessageContext(paths, {
          threadId: parsedTarget.threadId,
          messageSelector: parsedTarget.messageSelector,
          before: actionOptions.before,
          after: actionOptions.after,
        });
        if (!context) {
          return yield* fail(
            "message-not-found",
            `Message ${parsedTarget.messageSelector} was not found in thread ${parsedTarget.threadId}.`,
          );
        }
        return {
          target: `thread:${parsedTarget.threadId}:${parsedTarget.messageSelector}`,
          thread,
          anchor: context.anchor,
          messages: context.messages,
        };
      }

      const thread = yield* getExistingThread(paths, parsedTarget.threadId);
      if (actionOptions.format === "jsonl") {
        const raw = yield* readRawJsonl(thread);
        if (!raw) {
          return yield* fail("raw-not-found", `Raw JSONL not found for thread: ${parsedTarget.threadId}`);
        }
        return { target: `thread:${parsedTarget.threadId}`, thread, path: raw.path, contents: raw.contents };
      }

      const messages = yield* getThreadMessages(paths, parsedTarget.threadId);
      if (actionOptions.full || actionOptions.format === "messages") {
        return {
          target: `thread:${parsedTarget.threadId}`,
          ...buildOpenMessagesPayload(thread, messages, {
            full: actionOptions.full,
            head: 4,
            tail: 4,
            maxChars: 4_000,
          }),
        };
      }

      return {
        target: `thread:${parsedTarget.threadId}`,
        thread,
        previewMessages: slicePreviewMessages(messages),
      };
    }),
  );
}

export function handleInspect(
  subject: string,
  value: string | undefined,
  related: boolean,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  if (subject === "source") {
    return handleInspectSource(options);
  }

  if (subject === "index") {
    return withReadyIndex(options, getThreadStats);
  }

  if (subject === "thread") {
    return withReadyIndex(options, (paths) =>
      Effect.gen(function* () {
        const threadId = yield* ensureValue(value, "thread id");
        const thread = yield* getExistingThread(paths, threadId);
        return {
          thread,
          related: related ? yield* getRelatedThreads(paths, threadId, 10) : [],
        };
      }),
    );
  }

  return fail("invalid-command", `Unknown inspect subject: ${subject}`);
}

export function handleAdmin(
  action: string,
  payload: string | undefined,
  options: GlobalOptions,
): Effect.Effect<unknown, CliFailure> {
  if (action === "init") {
    return handleAdminInit(options);
  }
  if (action === "reindex") {
    return handleAdminReindex(options);
  }
  if (action === "sql") {
    return handleAdminSql(payload, options);
  }
  return fail("invalid-command", `Unknown admin action: ${action}`);
}
