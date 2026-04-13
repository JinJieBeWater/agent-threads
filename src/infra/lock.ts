import { Effect } from "effect";

import { CliFailure } from "../errors.ts";
import { ensureParentDirectory, fileExists, readFileString, readModifiedTime, removeFile, writeExclusiveFile } from "./fs.ts";
import type { ResolvedPaths } from "../types.ts";

const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_WAIT_MS = 15_000;
const INDEX_LOCK_POLL_MS = 100;
const INDEX_LOCK_POLL_INTERVAL = `${INDEX_LOCK_POLL_MS} millis` as const;

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

export function waitForUnlockedIndex(paths: ResolvedPaths): Effect.Effect<void> {
  const lockFile = getIndexLockFile(paths);

  const wait = (): Effect.Effect<void> =>
    pruneStaleIndexLock(lockFile).pipe(
      Effect.flatMap(() => fileExists(lockFile).pipe(Effect.catchAll(() => Effect.succeed(false)))),
      Effect.flatMap((exists) =>
        exists
          ? Effect.sleep(INDEX_LOCK_POLL_INTERVAL).pipe(Effect.flatMap(wait))
          : Effect.void,
      ),
    );

  return wait();
}

export function withIndexBuildLock<A>(
  paths: ResolvedPaths,
  callback: Effect.Effect<A, CliFailure>,
): Effect.Effect<A, CliFailure> {
  const lockFile = getIndexLockFile(paths);

  const acquire = (startedAt: number): Effect.Effect<void, CliFailure> =>
    writeExclusiveFile(lockFile, `${process.pid} ${new Date().toISOString()}\n`).pipe(
      Effect.catchTag("CliFailure", (error) => {
        if (error.code !== "fs-already-exists") {
          return Effect.fail(error);
        }
        return pruneStaleIndexLock(lockFile).pipe(
          Effect.flatMap(() => fileExists(lockFile)),
          Effect.flatMap((exists) => {
            if (!exists) {
              return Effect.fail(new CliFailure({ code: "retry-lock-acquire", message: "retry" }));
            }
            if (Date.now() - startedAt > INDEX_LOCK_WAIT_MS) {
              return Effect.fail(
                new CliFailure({
                  code: "index-lock-timeout",
                  message: `Timed out waiting for index lock: ${lockFile}`,
                }),
              );
            }
            return Effect.fail(new CliFailure({ code: "retry-lock-acquire", message: "retry" }));
          }),
        );
      }),
    ).pipe(
      Effect.catchTag("CliFailure", (error) =>
        error.code === "retry-lock-acquire"
          ? Effect.sleep(INDEX_LOCK_POLL_INTERVAL).pipe(Effect.flatMap(() => acquire(startedAt)))
          : Effect.fail(error),
      ),
    );

  return Effect.acquireUseRelease(
    ensureParentDirectory(lockFile).pipe(Effect.flatMap(() => acquire(Date.now()))),
    () => callback,
    () => removeFile(lockFile).pipe(Effect.catchAll(() => Effect.void)),
  );
}
