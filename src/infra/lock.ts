import { Effect } from "effect";

import { CliFailure } from "../errors.ts";
import { ensureParentDirectory, fileExists, readFileString, readModifiedTime, removeFile, writeExclusiveFile } from "./fs.ts";
import type { ResolvedPaths } from "../types.ts";

const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_WAIT_MS = 15_000;
const INDEX_LOCK_POLL_MS = 100;
const INDEX_LOCK_POLL_INTERVAL = `${INDEX_LOCK_POLL_MS} millis` as const;

export interface IndexWriterLease {
  pid: number | null;
  startedAt: string | null;
  mode: string | null;
  lockFile: string;
}

function getIndexLockFile(paths: ResolvedPaths): string {
  return `${paths.indexDb}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function pruneStaleIndexLock(lockFile: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const modifiedTime = yield* readModifiedTime(lockFile).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (modifiedTime === null || Date.now() - modifiedTime <= INDEX_LOCK_STALE_MS) {
      return;
    }

    const contents = yield* readFileString(lockFile).pipe(Effect.catchAll(() => Effect.succeed("")));
    const pidToken = contents.trim().split(/\s+/, 1)[0] ?? "";
    const pid = /^\d+$/.test(pidToken) ? Number(pidToken) : null;
    if (pid !== null && isProcessAlive(pid)) {
      return;
    }

    yield* removeFile(lockFile).pipe(Effect.catchAll(() => Effect.void));
  });
}

function parseIndexWriterLease(lockFile: string, contents: string): IndexWriterLease | null {
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const [pidToken, startedAtToken, modeToken] = trimmed.split(/\s+/, 3);
  const pid = pidToken && /^\d+$/.test(pidToken) ? Number(pidToken) : null;
  const startedAt = startedAtToken && startedAtToken.length > 0 ? startedAtToken : null;
  const mode = modeToken && modeToken.length > 0 ? modeToken : null;

  if (pid === null && startedAt === null && mode === null) {
    return null;
  }

  return {
    pid,
    startedAt,
    mode,
    lockFile,
  };
}

export function readActiveIndexWriter(paths: ResolvedPaths): Effect.Effect<IndexWriterLease | null> {
  const lockFile = getIndexLockFile(paths);
  return Effect.gen(function* () {
    yield* pruneStaleIndexLock(lockFile).pipe(Effect.catchAll(() => Effect.void));
    const exists = yield* fileExists(lockFile).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      return null;
    }

    const contents = yield* readFileString(lockFile).pipe(Effect.catchAll(() => Effect.succeed("")));
    return parseIndexWriterLease(lockFile, contents);
  });
}

export function waitForIndexWriter(paths: ResolvedPaths, timeoutMs = INDEX_LOCK_WAIT_MS): Effect.Effect<void, CliFailure> {
  const startedAt = Date.now();

  const wait = (): Effect.Effect<void, CliFailure> =>
    readActiveIndexWriter(paths).pipe(
      Effect.flatMap((lease) => {
        if (!lease) {
          return Effect.void;
        }
        if (Date.now() - startedAt > timeoutMs) {
          return Effect.fail(
            new CliFailure({
              code: "index-lock-timeout",
              message: `Timed out waiting for index lock: ${lease.lockFile}`,
            }),
          );
        }
        return Effect.sleep(INDEX_LOCK_POLL_INTERVAL).pipe(Effect.flatMap(wait));
      }),
    );

  return wait();
}

function acquireIndexWriterLease(
  lockFile: string,
  mode: string,
  startedAt: number,
  waitForLease: boolean,
): Effect.Effect<boolean, CliFailure> {
  return writeExclusiveFile(lockFile, `${process.pid} ${new Date().toISOString()} ${mode}\n`).pipe(
    Effect.as(true),
    Effect.catchTag("CliFailure", (error) => {
      if (error.code !== "fs-already-exists") {
        return Effect.fail(error);
      }
      return pruneStaleIndexLock(lockFile).pipe(
        Effect.flatMap(() => fileExists(lockFile)),
        Effect.flatMap((exists) => {
          if (!exists) {
            return acquireIndexWriterLease(lockFile, mode, startedAt, waitForLease);
          }
          if (!waitForLease) {
            return Effect.succeed(false);
          }
          if (Date.now() - startedAt > INDEX_LOCK_WAIT_MS) {
            return Effect.fail(
              new CliFailure({
                code: "index-lock-timeout",
                message: `Timed out waiting for index lock: ${lockFile}`,
              }),
            );
          }
          return Effect.sleep(INDEX_LOCK_POLL_INTERVAL).pipe(
            Effect.flatMap(() => acquireIndexWriterLease(lockFile, mode, startedAt, waitForLease)),
          );
        }),
      );
    }),
  );
}

function withIndexWriterLeaseInternal<A>(
  paths: ResolvedPaths,
  mode: string,
  waitForLease: boolean,
  callback: Effect.Effect<A, CliFailure>,
): Effect.Effect<A | null, CliFailure> {
  const lockFile = getIndexLockFile(paths);

  return Effect.acquireUseRelease(
    ensureParentDirectory(lockFile).pipe(
      Effect.flatMap(() => acquireIndexWriterLease(lockFile, mode, Date.now(), waitForLease)),
    ),
    (acquired) => (acquired ? callback : Effect.succeed(null)),
    (acquired) => (acquired ? removeFile(lockFile).pipe(Effect.catchAll(() => Effect.void)) : Effect.void),
  );
}

export function withIndexWriterLease<A>(
  paths: ResolvedPaths,
  mode: string,
  callback: Effect.Effect<A, CliFailure>,
): Effect.Effect<A, CliFailure> {
  return withIndexWriterLeaseInternal(paths, mode, true, callback).pipe(
    Effect.flatMap((result) =>
      result === null
        ? Effect.fail(new CliFailure({ code: "index-lock-timeout", message: `Timed out waiting for index lock: ${getIndexLockFile(paths)}` }))
        : Effect.succeed(result),
    ),
  );
}

export function tryWithIndexWriterLease<A>(
  paths: ResolvedPaths,
  mode: string,
  callback: Effect.Effect<A, CliFailure>,
): Effect.Effect<A | null, CliFailure> {
  return withIndexWriterLeaseInternal(paths, mode, false, callback);
}
