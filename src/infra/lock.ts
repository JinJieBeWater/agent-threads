import { Effect } from "effect";

import { CliFailure } from "../errors.ts";
import { ensureParentDirectory, fileExists, readModifiedTime, removeFile, writeExclusiveFile } from "./fs.ts";
import type { ResolvedPaths } from "../types.ts";

const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_WAIT_MS = 15_000;
const INDEX_LOCK_POLL_MS = 100;
const INDEX_LOCK_POLL_INTERVAL = `${INDEX_LOCK_POLL_MS} millis` as const;

function getIndexLockFile(paths: ResolvedPaths): string {
  return `${paths.indexDb}.lock`;
}

function pruneStaleIndexLock(lockFile: string): Effect.Effect<void> {
  return readModifiedTime(lockFile).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.flatMap((modifiedTime) => {
      if (modifiedTime === null) {
        return Effect.void;
      }
      if (Date.now() - modifiedTime <= INDEX_LOCK_STALE_MS) {
        return Effect.void;
      }
      return removeFile(lockFile).pipe(Effect.catchAll(() => Effect.void));
    }),
  );
}

function hasActiveIndexLock(paths: ResolvedPaths): Effect.Effect<boolean> {
  const lockFile = getIndexLockFile(paths);
  return Effect.gen(function* () {
    const exists = yield* fileExists(lockFile).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      return false;
    }
    yield* pruneStaleIndexLock(lockFile);
    return yield* fileExists(lockFile).pipe(Effect.catchAll(() => Effect.succeed(false)));
  });
}

export function waitForUnlockedIndex(paths: ResolvedPaths): Effect.Effect<void> {
  const loop = (): Effect.Effect<void> =>
    hasActiveIndexLock(paths).pipe(
      Effect.flatMap((locked) => (locked ? Effect.sleep(INDEX_LOCK_POLL_INTERVAL).pipe(Effect.flatMap(loop)) : Effect.void)),
    );
  return loop();
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
