import { sep } from "node:path";
import { Effect } from "effect";

import { resolveLiveGitScope } from "./infra/git.ts";
import { all, get, withDatabase } from "./infra/sqlite.ts";
import type { CliFailure } from "./errors.ts";
import { appendQueryScopeClauses, derivePathScopes } from "./query-scope.ts";
import type { QueryScopeOptions, ResolvedPaths } from "./types.ts";

const SNIPPET_LENGTH = 220;
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTextExpression(columnName: string): string {
  return `(instr(${columnName}, ?) > 0 OR instr(lower(${columnName}), lower(?)) > 0)`;
}

function normalizedEpochExpression(columnName: string): string {
  return `(CASE WHEN ${columnName} > 0 AND ${columnName} < ${EPOCH_MS_THRESHOLD} THEN ${columnName} * 1000 ELSE ${columnName} END)`;
}

function noisyTextSqlExpression(columnName: string): string {
  const escapedPatterns = NOISY_TEXT_PATTERNS.map((pattern) => pattern.replace(/'/g, "''"));
  return `(${[`length(trim(${columnName})) > 1500`, ...escapedPatterns.map((pattern) => `instr(${columnName}, '${pattern}') > 0`)].join(" OR ")})`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function hasCleanThreadMetadata(title: string | null, firstUserMessage: string | null): boolean {
  return (
    (typeof title === "string" && title.length > 0 && !isNoisyText(title)) ||
    (typeof firstUserMessage === "string" &&
      firstUserMessage.length > 0 &&
      !isNoisyText(firstUserMessage))
  );
}

function startsWithScope(path: string, scope: string | null): boolean {
  return typeof scope === "string" && (path === scope || path.startsWith(`${scope}${sep}`));
}

function aliasScopePath(cwd: string, resolvedPath: string | null, canonicalScope: string | null): string | null {
  if (!canonicalScope) {
    return null;
  }
  if (!resolvedPath) {
    return canonicalScope;
  }

  const observedDerived = derivePathScopes(cwd);
  const resolvedDerived = derivePathScopes(resolvedPath);
  if (observedDerived.pathKind === "worktree" && resolvedDerived.pathKind === "worktree") {
    if (canonicalScope === resolvedDerived.worktreeScope && observedDerived.worktreeScope) {
      return observedDerived.worktreeScope;
    }
    if (canonicalScope === resolvedDerived.repoScope && observedDerived.repoScope) {
      return observedDerived.repoScope;
    }
  }

  if (resolvedPath === canonicalScope) {
    return cwd;
  }
  if (!resolvedPath.startsWith(`${canonicalScope}${sep}`)) {
    return canonicalScope;
  }

  const suffix = resolvedPath.slice(canonicalScope.length + sep.length);
  if (suffix.length === 0) {
    return cwd;
  }
  return cwd.endsWith(`${sep}${suffix}`) ? cwd.slice(0, cwd.length - suffix.length - sep.length) : canonicalScope;
}

export function buildSnippet(value: string, query: string, maxLength = SNIPPET_LENGTH): string {
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

function matchesSearchText(value: string | null | undefined, query: string): boolean {
  const normalizedValue = typeof value === "string" ? normalizeSearchText(value) : "";
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedValue.length === 0 || normalizedQuery.length === 0) {
    return false;
  }

  if (/^[A-Za-z0-9_-]{2,}$/.test(normalizedQuery)) {
    const boundaryPattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(normalizedQuery)}([^A-Za-z0-9_]|$)`, "i");
    return boundaryPattern.test(normalizedValue);
  }

  return normalizedValue.toLowerCase().includes(normalizedQuery.toLowerCase());
}

export function isNoisyText(value: string | null | undefined): boolean {
  const normalized = typeof value === "string" ? normalizeSearchText(value) : "";
  if (normalized.length === 0) {
    return false;
  }

  if (normalized.length > 1_500) {
    return true;
  }

  return NOISY_TEXT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function listThreads(
  paths: ResolvedPaths,
  options: QueryScopeOptions & {
    provider?: string;
    limit: number;
    sinceEpochMs?: number;
    untilEpochMs?: number;
  },
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
    const updatedAtExpression = normalizedEpochExpression("updated_at");
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.provider) {
      where.push("model_provider = ?");
      params.push(options.provider);
    }
    appendQueryScopeClauses(where, params, options, "cwd");
    if (typeof options.sinceEpochMs === "number") {
      where.push(`${updatedAtExpression} >= ?`);
      params.push(options.sinceEpochMs);
    }
    if (typeof options.untilEpochMs === "number") {
      where.push(`${updatedAtExpression} <= ?`);
      params.push(options.untilEpochMs);
    }

    const sql = `
      SELECT
        thread_id,
        title,
        first_user_message,
        model_provider,
        cwd,
        ${updatedAtExpression} AS updated_at,
        archived,
        source_kind,
        message_count,
        user_message_count,
        assistant_message_count,
        last_message_at
      FROM threads
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${updatedAtExpression} DESC NULLS LAST, thread_id DESC
      LIMIT ?
    `;
    params.push(options.limit);
    return yield* all<Record<string, unknown>>(db, sql, ...params);
    }),
  );
}

export function searchThreads(
  paths: ResolvedPaths,
  options: QueryScopeOptions & {
    query: string;
    provider?: string;
    limit: number;
    sinceEpochMs?: number;
    untilEpochMs?: number;
  },
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
    const threadUpdatedAtExpression = normalizedEpochExpression("updated_at");
    const joinedUpdatedAtExpression = normalizedEpochExpression("t.updated_at");
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
    appendQueryScopeClauses(threadWhere, threadParams, options, "cwd");
    if (typeof options.sinceEpochMs === "number") {
      threadWhere.push(`${threadUpdatedAtExpression} >= ?`);
      threadParams.push(options.sinceEpochMs);
    }
    if (typeof options.untilEpochMs === "number") {
      threadWhere.push(`${threadUpdatedAtExpression} <= ?`);
      threadParams.push(options.untilEpochMs);
    }

    const titleMatches = yield* all<Record<string, unknown>>(
      db,
      `
          SELECT
            thread_id,
            title,
            model_provider,
            cwd,
            ${threadUpdatedAtExpression} AS updated_at,
            archived,
            source_kind,
            message_count,
            user_message_count,
            assistant_message_count,
            last_message_at,
            first_user_message
          FROM threads
          WHERE ${threadWhere.join(" AND ")}
          ORDER BY ${threadUpdatedAtExpression} DESC NULLS LAST
          LIMIT ?
        `,
      ...threadParams,
      options.limit * 3,
    );

    for (const thread of titleMatches) {
      const title = typeof thread.title === "string" ? thread.title : null;
      const firstUserMessage =
        typeof thread.first_user_message === "string" ? thread.first_user_message : null;
      const metadataNoisy = hasCleanThreadMetadata(title, firstUserMessage) ? 0 : 1;
      result.set(String(thread.thread_id), {
        thread_id: thread.thread_id,
        title,
        first_user_message: firstUserMessage,
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
        metadata_noisy: metadataNoisy,
        matched_text_noisy: 1,
        noisy_match: metadataNoisy,
      });
    }

    const messageWhere = [containsTextExpression("m.text")];
    const messageParams: Array<string | number> = [options.query, options.query];
    if (options.provider) {
      messageWhere.push("t.model_provider = ?");
      messageParams.push(options.provider);
    }
    appendQueryScopeClauses(messageWhere, messageParams, options, "t.cwd");
    if (typeof options.sinceEpochMs === "number") {
      messageWhere.push(`${joinedUpdatedAtExpression} >= ?`);
      messageParams.push(options.sinceEpochMs);
    }
    if (typeof options.untilEpochMs === "number") {
      messageWhere.push(`${joinedUpdatedAtExpression} <= ?`);
      messageParams.push(options.untilEpochMs);
    }

    const messageMatches = yield* all<Record<string, unknown>>(
      db,
      `
          WITH matched_messages AS (
            SELECT
              t.thread_id,
              t.title,
              t.model_provider,
              t.cwd,
              ${joinedUpdatedAtExpression} AS updated_at,
              t.archived,
              t.source_kind,
              t.message_count,
              t.user_message_count,
              t.assistant_message_count,
              t.last_message_at,
              t.first_user_message,
              m.text AS matched_text,
              CASE WHEN ${noisyTextSqlExpression("m.text")} THEN 1 ELSE 0 END AS matched_text_noisy,
              ROW_NUMBER() OVER (
                PARTITION BY t.thread_id
                ORDER BY
                  CASE WHEN ${noisyTextSqlExpression("m.text")} THEN 1 ELSE 0 END ASC,
                  m.created_at DESC NULLS LAST,
                  m.message_pk DESC
              ) AS row_num,
              COUNT(*) OVER (PARTITION BY t.thread_id) AS message_hit_count
            FROM messages m
            JOIN threads t ON t.thread_id = m.thread_id
            WHERE ${messageWhere.join(" AND ")}
          )
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
            first_user_message,
            message_hit_count,
            matched_text,
            matched_text_noisy
          FROM matched_messages
          WHERE row_num = 1
          ORDER BY matched_text_noisy ASC, message_hit_count DESC, updated_at DESC NULLS LAST
          LIMIT ?
        `,
      ...messageParams,
      options.limit * 5,
    );

    for (const thread of messageMatches) {
      const threadId = String(thread.thread_id);
      const current = result.get(threadId);
      const title = typeof thread.title === "string" ? thread.title : null;
      const firstUserMessage =
        typeof thread.first_user_message === "string" ? thread.first_user_message : null;
      const matchedText = typeof thread.matched_text === "string" ? thread.matched_text : null;
      const metadataNoisy = hasCleanThreadMetadata(title, firstUserMessage) ? 0 : 1;
      const matchedTextNoisy = matchedText ? Number(thread.matched_text_noisy ?? 0) : 1;
      result.set(threadId, {
        ...(current ?? {
          thread_id: thread.thread_id,
          title,
          first_user_message: firstUserMessage,
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
          metadata_noisy: metadataNoisy,
          matched_text_noisy: 1,
          noisy_match: 0,
        }),
        title,
        first_user_message: firstUserMessage,
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
        metadata_noisy: metadataNoisy,
        matched_text_noisy: matchedTextNoisy,
        noisy_match: metadataNoisy && matchedTextNoisy ? 1 : 0,
      });
    }

    const sortedResults = Array.from(result.values())
      .filter((row) => {
        const title = typeof row.title === "string" ? row.title : null;
        const firstUserMessage =
          typeof row.first_user_message === "string" ? row.first_user_message : null;
        const messageSnippet = typeof row.message_snippet === "string" ? row.message_snippet : null;
        return (
          matchesSearchText(title, options.query) ||
          matchesSearchText(firstUserMessage, options.query) ||
          matchesSearchText(messageSnippet, options.query)
        );
      })
      .sort((left, right) => {
        const noisyDelta = Number(left.noisy_match ?? 0) - Number(right.noisy_match ?? 0);
        if (noisyDelta !== 0) {
          return noisyDelta;
        }
        const metadataDelta = Number(left.metadata_noisy ?? 0) - Number(right.metadata_noisy ?? 0);
        if (metadataDelta !== 0) {
          return metadataDelta;
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
      });

    const cleanResults = sortedResults.filter((row) => Number(row.noisy_match ?? 0) === 0);
    const noisyResults = sortedResults.filter((row) => Number(row.noisy_match ?? 0) !== 0);
    return (cleanResults.length > 0 ? cleanResults : noisyResults).slice(0, options.limit);
    }),
  );
}

export function getThread(paths: ResolvedPaths, threadId: string): Effect.Effect<Record<string, unknown> | null, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    get<Record<string, unknown>>(db, `SELECT * FROM threads WHERE thread_id = ?`, threadId),
  );
}

export function getThreadMessages(
  paths: ResolvedPaths,
  threadId: string,
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    all<Record<string, unknown>>(
        db,
        `
            SELECT thread_id, seq, message_ref, role, kind, phase, text, created_at, source_file, source_line
            FROM messages
            WHERE thread_id = ?
            ORDER BY seq ASC
          `,
        threadId,
      ),
  );
}

export function getThreadStats(paths: ResolvedPaths): Effect.Effect<Record<string, unknown>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
    const messagesTable = yield* get<Record<string, unknown>>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
    );
    const totals = (yield* get<Record<string, unknown>>(
      db,
      `
          SELECT
            COUNT(*) AS thread_count,
            SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_count,
            COALESCE(SUM(message_count), 0) AS indexed_message_count
          FROM threads
        `,
    )) ?? {};
    const actualMessageTotals =
      messagesTable
        ? ((yield* get<Record<string, unknown>>(
            db,
            `SELECT COUNT(*) AS message_count FROM messages`,
          )) ?? {})
        : {};

    const providers = yield* all<Record<string, unknown>>(
      db,
      `
          SELECT model_provider, COUNT(*) AS count
          FROM threads
          GROUP BY model_provider
          ORDER BY count DESC, model_provider ASC
        `,
    );

    const topCwds = yield* all<Record<string, unknown>>(
      db,
      `
          SELECT cwd, COUNT(*) AS count
          FROM threads
          GROUP BY cwd
          ORDER BY count DESC, cwd ASC
          LIMIT 10
        `,
    );

    const meta = yield* all<{ key: string; value: string }>(db, `SELECT key, value FROM meta`);

    return {
      ...totals,
      message_count: Number(actualMessageTotals.message_count ?? totals.indexed_message_count ?? 0),
      providers,
      topCwds,
      meta: Object.fromEntries(meta.map((row) => [row.key, row.value])),
    };
    }),
  );
}

export function getObservedPaths(
  paths: ResolvedPaths,
  options: {
    match?: string;
    limit: number;
  },
): Effect.Effect<Record<string, unknown>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
      const where = ["cwd IS NOT NULL", "cwd != ''"];
      const params: Array<string | number> = [];

      if (options.match) {
        where.push(
          `(${containsTextExpression("cwd")} OR ${containsTextExpression("COALESCE(git_branch, '')")} OR ${containsTextExpression("COALESCE(git_origin_url, '')")})`,
        );
        params.push(
          options.match,
          options.match,
          options.match,
          options.match,
          options.match,
          options.match,
        );
      }

      params.push(options.limit);
      const rows = yield* all<Record<string, unknown>>(
        db,
        `
            SELECT
              cwd,
              COUNT(*) AS thread_count,
              MAX(${normalizedEpochExpression("updated_at")}) AS last_updated_at,
              MAX(NULLIF(git_branch, '')) AS sample_branch,
              MAX(NULLIF(git_origin_url, '')) AS sample_origin
            FROM threads
            WHERE ${where.join(" AND ")}
            GROUP BY cwd
            ORDER BY last_updated_at DESC NULLS LAST, thread_count DESC, cwd ASC
            LIMIT ?
          `,
        ...params,
      );

      const derivedRows = rows.map((row) => {
        const cwd = firstString(row.cwd) ?? "";
        const derived = derivePathScopes(cwd);
        return {
          cwd,
          observed_path_kind: derived.pathKind,
          observed_repo_scope: derived.repoScope,
          observed_worktree_scope: derived.worktreeScope,
          thread_count: Number(row.thread_count ?? 0),
          last_updated_at: Number(row.last_updated_at ?? 0),
          sample_branch: firstString(row.sample_branch),
          sample_origin: firstString(row.sample_origin),
        };
      });

      const liveRows = yield* Effect.forEach(
        derivedRows,
        (row) =>
          resolveLiveGitScope(row.cwd).pipe(
            Effect.map((live) => ({
              ...row,
              path_exists: live.pathExists,
              resolved_path: live.resolvedPath,
              live_verified: live.liveVerified,
              live_status: live.liveStatus,
              live_repo_scope: live.liveRepoScope,
              live_worktree_scope: live.liveWorktreeScope,
              live_error: live.liveError,
            })),
          ),
        { concurrency: 8 },
      );

      const knownRepoScopes = new Set(
        liveRows
          .flatMap((row) => [row.live_repo_scope, row.observed_repo_scope])
          .filter((value): value is string => value !== null),
      );

      const originToRepoScopes = new Map<string, Set<string>>();
      for (const row of liveRows) {
        if (!row.sample_origin) {
          continue;
        }
        const scopes = originToRepoScopes.get(row.sample_origin) ?? new Set<string>();
        if (row.live_repo_scope) {
          scopes.add(row.live_repo_scope);
        }
        if (row.observed_repo_scope) {
          scopes.add(row.observed_repo_scope);
        }
        if (scopes.size > 0) {
          originToRepoScopes.set(row.sample_origin, scopes);
        }
      }

      const results = liveRows.map((row) => {
        const liveRepoScope = aliasScopePath(row.cwd, row.resolved_path, row.live_repo_scope);
        const liveWorktreeScope = aliasScopePath(row.cwd, row.resolved_path, row.live_worktree_scope);
        let repoScope = liveRepoScope ?? row.observed_repo_scope;
        let worktreeScope = liveWorktreeScope ?? row.observed_worktree_scope;
        let pathKind: "cwd" | "repo" | "worktree" = row.observed_path_kind;

        if (!repoScope) {
          const matchedRepoScope =
            Array.from(knownRepoScopes).find((candidate) => startsWithScope(row.cwd, candidate)) ?? null;
          if (matchedRepoScope) {
            repoScope = matchedRepoScope;
          }
        }

        if (!repoScope && row.sample_origin) {
          const scopes = originToRepoScopes.get(row.sample_origin);
          if (scopes?.size === 1) {
            const [singleScope] = Array.from(scopes);
            if (startsWithScope(row.cwd, singleScope)) {
              repoScope = singleScope;
            }
          }
        }

        const canonicalScopedWorktree =
          row.live_worktree_scope && row.live_repo_scope && row.live_worktree_scope !== row.live_repo_scope
            ? row.live_worktree_scope
            : !row.live_verified
              ? worktreeScope
              : null;

        if (canonicalScopedWorktree && startsWithScope(row.resolved_path ?? row.cwd, canonicalScopedWorktree)) {
          pathKind = "worktree";
        } else if (repoScope && row.cwd === repoScope) {
          pathKind = "repo";
        } else if (!repoScope && row.observed_path_kind === "worktree" && row.observed_worktree_scope) {
          pathKind = "worktree";
          worktreeScope = row.observed_worktree_scope;
          repoScope = row.observed_repo_scope;
        } else {
          pathKind = "cwd";
        }

        const recommendedScope =
          worktreeScope && canonicalScopedWorktree
            ? {
                kind: "worktree",
                flag: "--worktree",
                value: worktreeScope,
              }
            : repoScope
              ? {
                  kind: "repo",
                  flag: "--repo",
                  value: repoScope,
                }
              : {
                  kind: "cwd",
                  flag: "--cwd",
                  value: row.cwd,
                };

        return {
          cwd: row.cwd,
          path_kind: pathKind,
          repo_scope: repoScope,
          worktree_scope: worktreeScope,
          path_exists: row.path_exists,
          live_status: row.live_status,
          live_repo_scope: liveRepoScope,
          live_worktree_scope: liveWorktreeScope,
          live_error: row.live_error,
          recommended_scope: recommendedScope,
          thread_count: row.thread_count,
          last_updated_at: row.last_updated_at > 0 ? new Date(row.last_updated_at).toISOString() : null,
          sample_branch: row.sample_branch,
          sample_origin: row.sample_origin,
        };
      });

      return {
        subject: "paths",
        match: options.match ?? null,
        results,
      };
    }),
  );
}

export function getRelatedThreads(
  paths: ResolvedPaths,
  threadId: string,
  limit: number,
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return withDatabase(paths.indexDb, (db) =>
    Effect.gen(function* () {
    const updatedAtExpression = normalizedEpochExpression("updated_at");
    const target = yield* get<Record<string, unknown>>(db, `SELECT * FROM threads WHERE thread_id = ?`, threadId);
    if (!target) {
      return [];
    }

    const cwd = firstString(target.cwd);
    if (cwd) {
      return yield* all<Record<string, unknown>>(
        db,
        `
            SELECT thread_id, title, cwd, model_provider, ${updatedAtExpression} AS updated_at
            FROM threads
            WHERE thread_id != ? AND cwd = ?
            ORDER BY ${updatedAtExpression} DESC NULLS LAST
            LIMIT ?
          `,
        threadId,
        cwd,
        limit,
      );
    }

    return yield* all<Record<string, unknown>>(
      db,
      `
          SELECT thread_id, title, cwd, model_provider, ${updatedAtExpression} AS updated_at
          FROM threads
          WHERE thread_id != ?
          ORDER BY ${updatedAtExpression} DESC NULLS LAST
          LIMIT ?
        `,
      threadId,
      limit,
    );
    }),
  );
}
