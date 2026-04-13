import { Effect } from "effect";

import { resolvePaths } from "./config.ts";
import type { CliFailure } from "./errors.ts";
import { waitForUnlockedIndex, withIndexBuildLock } from "./infra/lock.ts";
import { readIndexMetaInternal } from "./indexer-store.ts";
import {
  canSkipIncrementalSync,
  rebuildIndexUnlocked,
  type RebuildIndexStats,
  synchronizeTrustedActiveThreadsUnlocked,
  synchronizeIncrementalUnlocked,
} from "./indexer-sync.ts";
import { isIndexUsable } from "./indexer-store.ts";
import type { GlobalOptions, ResolvedPaths } from "./types.ts";

export type { RebuildIndexStats } from "./indexer-sync.ts";

export function readIndexMeta(paths: ResolvedPaths): Effect.Effect<Record<string, string>, CliFailure> {
  return readIndexMetaInternal(paths);
}

export function rebuildIndex(paths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
  return withIndexBuildLock(paths, rebuildIndexUnlocked(paths));
}

export function ensureIndex(paths: ResolvedPaths, _refresh: boolean): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    if (yield* canSkipIncrementalSync(paths)) {
      return;
    }

    yield* waitForUnlockedIndex(paths);

    if (yield* canSkipIncrementalSync(paths)) {
      return;
    }

    yield* withIndexBuildLock(
      paths,
      Effect.gen(function* () {
        if (yield* canSkipIncrementalSync(paths)) {
          return;
        }

        const usable = yield* isIndexUsable(paths);
        if (!usable) {
          yield* rebuildIndexUnlocked(paths);
          return;
        }

        if (yield* synchronizeTrustedActiveThreadsUnlocked(paths)) {
          return;
        }

        yield* synchronizeIncrementalUnlocked(paths);
      }),
    );
  });
}

export function resolvePathsEffect(options: GlobalOptions): Effect.Effect<ResolvedPaths, CliFailure> {
  return resolvePaths(options);
}
