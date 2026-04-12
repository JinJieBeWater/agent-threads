import { Effect } from "effect";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";

import { CliFailure } from "../errors.ts";

type SqlDatabase = SqliteClient.SqliteClient;

export function withDatabase<A>(
  filePath: string,
  use: (db: SqlDatabase) => Effect.Effect<A, CliFailure>,
): Effect.Effect<A, CliFailure> {
  return Effect.scoped(
    SqliteClient.make({ filename: filePath }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.flatMap(use),
      Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
    ),
  );
}

export function openDatabase(filePath: string): Effect.Effect<SqlDatabase, CliFailure> {
  return Effect.scoped(
    SqliteClient.make({ filename: filePath }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
    ),
  );
}

export function all<T extends Record<string, unknown>>(
  db: SqlDatabase,
  sql: string,
  ...params: Array<string | number>
): Effect.Effect<T[], CliFailure> {
  return db.unsafe<T>(sql, params).pipe(
    Effect.map((rows) => Array.from(rows)),
    Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
  );
}

export function get<T extends Record<string, unknown>>(
  db: SqlDatabase,
  sql: string,
  ...params: Array<string | number>
): Effect.Effect<T | null, CliFailure> {
  return all<T>(db, sql, ...params).pipe(Effect.map((rows) => rows[0] ?? null));
}

export function exec(
  db: SqlDatabase,
  sql: string,
  ...params: Array<string | number>
): Effect.Effect<void, CliFailure> {
  return db.unsafe(sql, params).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new CliFailure({ code: "sqlite-error", message: String(cause) })),
  );
}

export type DatabaseClient = SqlDatabase;
