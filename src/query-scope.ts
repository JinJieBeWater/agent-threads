import { sep } from "node:path";
import { Effect } from "effect";

import { CliFailure } from "./errors.ts";
import { normalizeAbsolutePath, trimTrailingSeparators } from "./path-utils.ts";
import type { QueryScopeOptions } from "./types.ts";

function normalizeScopePath(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return normalizeAbsolutePath(trimmed);
}

export type DerivedPathKind = "cwd" | "worktree";

export interface DerivedPathScopes {
  pathKind: DerivedPathKind;
  repoScope: string | null;
  worktreeScope: string | null;
}

export function derivePathScopes(value: string): DerivedPathScopes {
  const normalized = trimTrailingSeparators(value);
  const marker = ".worktrees";
  const markerIndex = normalized.indexOf(`${marker}${sep}`);

  if (markerIndex >= 0) {
    const repoScope = normalized.slice(0, markerIndex);
    const worktreeSuffix = normalized.slice(markerIndex + marker.length + sep.length);
    const worktreeName = worktreeSuffix.split(/[\\/]/, 1)[0] ?? "";
    const worktreeScope = worktreeName.length > 0 ? `${repoScope}${marker}${sep}${worktreeName}` : null;
    return {
      pathKind: "worktree",
      repoScope,
      worktreeScope,
    };
  }

  return {
    pathKind: "cwd",
    repoScope: null,
    worktreeScope: null,
  };
}

export function normalizeQueryScope(input: QueryScopeOptions): Effect.Effect<QueryScopeOptions, CliFailure> {
  return Effect.sync(() => {
    const scope = {
      cwd: normalizeScopePath(input.cwd),
      repo: normalizeScopePath(input.repo),
      worktree: normalizeScopePath(input.worktree),
    } satisfies QueryScopeOptions;

    const selectedScopeCount = Number(Boolean(scope.cwd)) + Number(Boolean(scope.repo)) + Number(Boolean(scope.worktree));
    if (selectedScopeCount > 1) {
      throw new CliFailure({
        code: "invalid-argument",
        message: "Use only one of --cwd, --repo, or --worktree.",
      });
    }

    return scope;
  });
}

export function appendQueryScopeClauses(
  where: string[],
  params: Array<string | number>,
  scope: QueryScopeOptions,
  columnName: string,
): void {
  if (scope.cwd) {
    where.push(`${columnName} = ?`);
    params.push(scope.cwd);
    return;
  }

  if (scope.repo) {
    const worktreesRoot = `${scope.repo}.worktrees`;
    where.push(`(${columnName} = ? OR instr(${columnName}, ?) = 1 OR instr(${columnName}, ?) = 1)`);
    params.push(scope.repo, `${scope.repo}${sep}`, `${worktreesRoot}${sep}`);
    return;
  }

  if (scope.worktree) {
    where.push(`(${columnName} = ? OR instr(${columnName}, ?) = 1)`);
    params.push(scope.worktree, `${scope.worktree}${sep}`);
  }
}
