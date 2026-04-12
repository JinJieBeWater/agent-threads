import { Effect } from "effect";

import { all, withDatabase } from "./infra/sqlite.ts";
import { CliFailure } from "./errors.ts";
import type { ResolvedPaths } from "./types.ts";

function stripSqlStringsAndComments(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1];

    if (char === "'" || char === "\"" || char === "`") {
      const quote = char;
      result += " ";
      index += 1;
      while (index < sql.length) {
        const current = sql[index] ?? "";
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

    if (char === "[") {
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

function assertReadOnlySql(sql: string): Effect.Effect<string, CliFailure> {
  return Effect.sync(() => {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    if (trimmed.length === 0) {
      throw new CliFailure({ code: "invalid-sql", message: "A SQL query is required." });
    }

    const stripped = stripSqlStringsAndComments(trimmed);
    if (/;(?=\s*\S)/.test(stripped)) {
      throw new CliFailure({ code: "invalid-sql", message: "Only a single read-only query is allowed." });
    }

    const normalized = stripped.trim();
    if (!/^(select|with)\b/i.test(normalized)) {
      throw new CliFailure({ code: "invalid-sql", message: "Only read-only SELECT and WITH queries are allowed." });
    }

    if (
      /\b(insert|update|delete|replace|create|drop|alter|truncate|attach|detach|vacuum|pragma|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i.test(
        normalized,
      )
    ) {
      throw new CliFailure({ code: "invalid-sql", message: "Only read-only SELECT and WITH queries are allowed." });
    }

    return trimmed;
  });
}

export function runReadOnlySql(
  paths: ResolvedPaths,
  sql: string,
): Effect.Effect<Array<Record<string, unknown>>, CliFailure> {
  return Effect.gen(function* () {
    const trimmed = yield* assertReadOnlySql(sql);
    return yield* withDatabase(paths.indexDb, (db) => all<Record<string, unknown>>(db, trimmed));
  });
}
