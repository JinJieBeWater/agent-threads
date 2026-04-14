import { Effect } from "effect";

import { all, get, withDatabase } from "./infra/sqlite.ts";
import { appendQueryScopeClauses } from "./query-scope.ts";
import { buildSnippet, isNoisyText, matchesSearchText } from "./threads.ts";
import type { CliFailure } from "./errors.ts";
import type { QueryScopeOptions, ResolvedPaths } from "./types.ts";

function containsTextExpression(columnName: string): string {
  return `(instr(${columnName}, ?) > 0 OR instr(lower(${columnName}), lower(?)) > 0)`;
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldUseFtsSearch(query: string): boolean {
  return normalizeQuery(query).length > 0;
}

function shouldFallbackToContainsAfterMiss(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (normalized.length < 3) {
    return true;
  }

  const singleToken = !/\s/.test(normalized);
  if (!singleToken) {
    return false;
  }

  return /[_./:#-]/.test(normalized);
}

function toFtsMatchQuery(query: string): string {
  const normalized = normalizeQuery(query);
  return `"${normalized.replaceAll('"', '""')}"`;
}

function candidateLimit(limit: number): number {
  return Math.max(limit * 10, limit);
}

function metadataHitDetails(
  title: unknown,
  firstUserMessage: unknown,
  query: string,
): {
  title_hit: 0 | 1;
  first_user_message_hit: 0 | 1;
  metadata_hit_score: number;
} {
  const titleHit = matchesSearchText(typeof title === "string" ? title : null, query) ? 1 : 0;
  const firstUserMessageHit = matchesSearchText(
    typeof firstUserMessage === "string" ? firstUserMessage : null,
    query,
  )
    ? 1
    : 0;
  return {
    title_hit: titleHit,
    first_user_message_hit: firstUserMessageHit,
    metadata_hit_score: titleHit * 2 + firstUserMessageHit,
  };
}

function dedupeMessageRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seenThreadIds = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const threadId = String(row.thread_id ?? "");
    if (seenThreadIds.has(threadId)) {
      continue;
    }
    seenThreadIds.add(threadId);
    deduped.push(row);
  }
  return deduped;
}

const META_DISCUSSION_PATTERNS = [
  "you are reviewing",
  "ground your review",
  "return concise review",
  "no code changes",
  "phase 1 fts",
  "trigram",
  "benchmark",
  "baseline",
  "reindex",
  "ensureindex",
  "selective sync",
  "static snapshot",
  "warm read",
  "review this planned",
];

function isBroadNaturalLanguageQuery(query: string): boolean {
  const normalized = normalizeQuery(query);
  return normalized.includes(" ") && !/[_./:#-]/.test(normalized);
}

function metaDiscussionPenalty(
  row: {
    title?: unknown;
    first_user_message?: unknown;
    text_snippet?: unknown;
  },
  query: string,
): number {
  const normalizedQuery = normalizeQuery(query).toLowerCase();
  if (/(ath|agent-threads|fts|trigram|benchmark|reindex|search|index)/.test(normalizedQuery)) {
    return 0;
  }

  const title = typeof row.title === "string" ? row.title : "";
  const firstUserMessage = typeof row.first_user_message === "string" ? row.first_user_message : "";
  const snippet = typeof row.text_snippet === "string" ? row.text_snippet : "";
  const combined = `${title}\n${firstUserMessage}\n${snippet}`.toLowerCase();

  let penalty = 0;
  for (const pattern of META_DISCUSSION_PATTERNS) {
    if (combined.includes(pattern)) {
      penalty += 1;
    }
  }
  if (title.length > 180 || firstUserMessage.length > 300) {
    penalty += 1;
  }
  return penalty;
}

function searchMessagesByContains(
  paths: ResolvedPaths,
  options: QueryScopeOptions & {
    query: string;
    threadId?: string;
    provider?: string;
    role?: string;
    limit: number;
    sinceIso?: string;
    untilIso?: string;
  },
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
      const where = [containsTextExpression("m.text")];
      const params: Array<string | number> = [options.query, options.query];
      if (options.threadId) {
        where.push("m.thread_id = ?");
        params.push(options.threadId);
      }
      if (options.provider) {
        where.push("t.model_provider = ?");
        params.push(options.provider);
      }
      appendQueryScopeClauses(where, params, options, "t.cwd");
      if (options.role) {
        where.push("m.role = ?");
        params.push(options.role);
      }
      if (options.sinceIso) {
        where.push("m.created_at >= ?");
        params.push(options.sinceIso);
      }
      if (options.untilIso) {
        where.push("m.created_at <= ?");
        params.push(options.untilIso);
      }

      params.push(candidateLimit(options.limit));
      const rows = yield* all<Record<string, unknown>>(
        db,
        `
            SELECT
              m.thread_id,
              m.seq,
              m.message_ref,
              m.role,
              m.kind,
              m.phase,
              m.text,
              m.created_at,
              t.title,
              t.first_user_message,
              t.model_provider,
              t.cwd
            FROM messages m
            JOIN threads t ON t.thread_id = m.thread_id
            WHERE ${where.join(" AND ")}
            ORDER BY m.created_at DESC NULLS LAST, m.message_pk DESC
            LIMIT ?
          `,
        ...params,
      );

      const rankedRows = rows
        .map((row) => {
          const text = String(row.text ?? "");
          const metadata = metadataHitDetails(row.title, row.first_user_message, options.query);
          return {
            thread_id: row.thread_id,
            seq: row.seq,
            message_ref: row.message_ref,
            role: row.role,
            kind: row.kind,
            phase: row.phase,
            text_snippet: buildSnippet(text, options.query),
            created_at: row.created_at,
            title: row.title,
            first_user_message: row.first_user_message,
            model_provider: row.model_provider,
            cwd: row.cwd,
            noisy_match: isNoisyText(text) ? 1 : 0,
            meta_discussion_penalty: 0,
            ...metadata,
          };
        })
        .map((row) => ({
          ...row,
          meta_discussion_penalty: metaDiscussionPenalty(row, options.query),
        }))
        .sort((left, right) => {
          const noisyDelta = Number(left.noisy_match) - Number(right.noisy_match);
          if (noisyDelta !== 0) {
            return noisyDelta;
          }
          const metaDiscussionDelta =
            isBroadNaturalLanguageQuery(options.query)
              ? Number(left.meta_discussion_penalty ?? 0) - Number(right.meta_discussion_penalty ?? 0)
              : 0;
          if (metaDiscussionDelta !== 0) {
            return metaDiscussionDelta;
          }
          const metadataDelta = Number(right.metadata_hit_score ?? 0) - Number(left.metadata_hit_score ?? 0);
          if (metadataDelta !== 0) {
            return metadataDelta;
          }
          const leftCreatedAt = typeof left.created_at === "string" ? Date.parse(left.created_at) : 0;
          const rightCreatedAt = typeof right.created_at === "string" ? Date.parse(right.created_at) : 0;
          return rightCreatedAt - leftCreatedAt;
        });

      return dedupeMessageRows(rankedRows).slice(0, options.limit);
    }),
  );
}

function searchMessagesByFts(
  paths: ResolvedPaths,
  options: QueryScopeOptions & {
    query: string;
    threadId?: string;
    provider?: string;
    role?: string;
    limit: number;
    sinceIso?: string;
    untilIso?: string;
  },
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
      const where = ["messages_fts MATCH ?"];
      const params: Array<string | number> = [toFtsMatchQuery(options.query)];
      if (options.threadId) {
        where.push("m.thread_id = ?");
        params.push(options.threadId);
      }
      if (options.provider) {
        where.push("t.model_provider = ?");
        params.push(options.provider);
      }
      appendQueryScopeClauses(where, params, options, "t.cwd");
      if (options.role) {
        where.push("m.role = ?");
        params.push(options.role);
      }
      if (options.sinceIso) {
        where.push("m.created_at >= ?");
        params.push(options.sinceIso);
      }
      if (options.untilIso) {
        where.push("m.created_at <= ?");
        params.push(options.untilIso);
      }

      params.push(candidateLimit(options.limit));
      const rows = yield* all<Record<string, unknown>>(
        db,
        `
            SELECT
              m.thread_id,
              m.seq,
              m.message_ref,
              m.role,
              m.kind,
              m.phase,
              m.text,
              m.created_at,
              t.title,
              t.first_user_message,
              t.model_provider,
              t.cwd,
              bm25(messages_fts) AS search_rank
            FROM messages_fts f
            JOIN messages m ON m.message_pk = f.rowid
            JOIN threads t ON t.thread_id = m.thread_id
            WHERE ${where.join(" AND ")}
            ORDER BY bm25(messages_fts) ASC, m.created_at DESC NULLS LAST, m.message_pk DESC
            LIMIT ?
          `,
        ...params,
      );

      const rankedRows = rows
        .map((row) => {
          const text = String(row.text ?? "");
          const metadata = metadataHitDetails(row.title, row.first_user_message, options.query);
          return {
            thread_id: row.thread_id,
            seq: row.seq,
            message_ref: row.message_ref,
            role: row.role,
            kind: row.kind,
            phase: row.phase,
            text_snippet: buildSnippet(text, options.query),
            created_at: row.created_at,
            title: row.title,
            first_user_message: row.first_user_message,
            model_provider: row.model_provider,
            cwd: row.cwd,
            noisy_match: isNoisyText(text) ? 1 : 0,
            search_rank: Number(row.search_rank ?? 0),
            meta_discussion_penalty: 0,
            ...metadata,
          };
        })
        .map((row) => ({
          ...row,
          meta_discussion_penalty: metaDiscussionPenalty(row, options.query),
        }))
        .sort((left, right) => {
          const noisyDelta = Number(left.noisy_match) - Number(right.noisy_match);
          if (noisyDelta !== 0) {
            return noisyDelta;
          }
          const metaDiscussionDelta =
            isBroadNaturalLanguageQuery(options.query)
              ? Number(left.meta_discussion_penalty ?? 0) - Number(right.meta_discussion_penalty ?? 0)
              : 0;
          if (metaDiscussionDelta !== 0) {
            return metaDiscussionDelta;
          }
          const metadataDelta = Number(right.metadata_hit_score ?? 0) - Number(left.metadata_hit_score ?? 0);
          if (metadataDelta !== 0) {
            return metadataDelta;
          }
          const rankDelta = Number(left.search_rank ?? 0) - Number(right.search_rank ?? 0);
          if (rankDelta !== 0) {
            return rankDelta;
          }
          const leftCreatedAt = typeof left.created_at === "string" ? Date.parse(left.created_at) : 0;
          const rightCreatedAt = typeof right.created_at === "string" ? Date.parse(right.created_at) : 0;
          return rightCreatedAt - leftCreatedAt;
        })
        .map(({ search_rank, ...row }) => row);

      return dedupeMessageRows(rankedRows).slice(0, options.limit);
    }),
  );
}

export function searchMessages(
  paths: ResolvedPaths,
  options: QueryScopeOptions & {
    query: string;
    threadId?: string;
    provider?: string;
    role?: string;
    limit: number;
    sinceIso?: string;
    untilIso?: string;
  },
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  const shouldFallback = shouldFallbackToContainsAfterMiss(options.query);
  return shouldUseFtsSearch(options.query)
    ? searchMessagesByFts(paths, options).pipe(
        Effect.catchTag("CliFailure", (error) =>
          shouldFallback ? searchMessagesByContains(paths, options) : Effect.fail(error),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0 || !shouldFallback
            ? Effect.succeed(rows)
            : searchMessagesByContains(paths, options),
        ),
      )
    : searchMessagesByContains(paths, options);
}

export function getMessageContext(
  paths: ResolvedPaths,
  input: {
    threadId: string;
    messageSelector: string;
    before: number;
    after: number;
  },
): Effect.Effect<{
  anchor: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
} | null, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
      const anchor =
        /^\d+$/.test(input.messageSelector)
          ? yield* get<Record<string, unknown>>(
              db,
              `SELECT * FROM messages WHERE thread_id = ? AND seq = ?`,
              input.threadId,
              Number(input.messageSelector),
            )
          : yield* get<Record<string, unknown>>(
              db,
              `SELECT * FROM messages WHERE thread_id = ? AND message_ref = ?`,
              input.threadId,
              input.messageSelector,
            );

      if (!anchor) {
        return null;
      }

      const seq = Number(anchor.seq);
      const messages = yield* all<Record<string, unknown>>(
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
    }),
  );
}
