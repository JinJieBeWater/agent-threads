import { Effect } from "effect";

import { all, get, withDatabase } from "./infra/sqlite.ts";
import { buildSnippet, isNoisyText } from "./threads.ts";
import type { CliFailure } from "./errors.ts";
import type { ResolvedPaths } from "./types.ts";

function containsTextExpression(columnName: string): string {
  return `(instr(${columnName}, ?) > 0 OR instr(lower(${columnName}), lower(?)) > 0)`;
}

export function searchMessages(
  paths: ResolvedPaths,
  options: {
    query: string;
    threadId?: string;
    provider?: string;
    cwd?: string;
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
      if (options.cwd) {
        where.push("t.cwd = ?");
        params.push(options.cwd);
      }
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

      params.push(Math.max(options.limit * 5, options.limit));
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
            title: row.title,
            model_provider: row.model_provider,
            cwd: row.cwd,
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
    }),
  );
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
