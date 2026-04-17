import { Effect } from "effect";

import { resolvePaths } from "./config.ts";
import type { CliFailure } from "./errors.ts";
import { readActiveIndexWriter, tryWithIndexWriterLease, waitForIndexWriter, withIndexWriterLease } from "./infra/lock.ts";
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

export interface EnsureIndexResult {
  freshness: "fresh" | "stale";
  activeWriterObserved: boolean;
}

export type EnsureIndexMode = "bounded-stale" | "strict";

export function readIndexMeta(paths: ResolvedPaths): Effect.Effect<Record<string, string>, CliFailure> {
  return readIndexMetaInternal(paths);
}

export function rebuildIndex(paths: ResolvedPaths): Effect.Effect<RebuildIndexStats, CliFailure> {
  return withIndexWriterLease(paths, "rebuild", rebuildIndexUnlocked(paths));
}

function synchronizeIndex(paths: ResolvedPaths): Effect.Effect<void, CliFailure> {
  return Effect.gen(function* () {
    if (yield* canSkipIncrementalSync(paths)) {
      return;
    }

    const usable = yield* isIndexUsable(paths);
    if (!usable) {
      yield* rebuildIndexUnlocked(paths, "in-place");
      return;
    }

    if (yield* synchronizeTrustedActiveThreadsUnlocked(paths)) {
      return;
    }

    yield* synchronizeIncrementalUnlocked(paths);
  });
}

export function ensureIndex(paths: ResolvedPaths, mode: EnsureIndexMode): Effect.Effect<EnsureIndexResult, CliFailure> {
  return Effect.gen(function* () {
    if (yield* canSkipIncrementalSync(paths)) {
      return {
        freshness: "fresh",
        activeWriterObserved: false,
      } satisfies EnsureIndexResult;
    }

    const usable = yield* isIndexUsable(paths);
    const activeWriter = yield* readActiveIndexWriter(paths);

    if (!usable) {
      if (activeWriter) {
        yield* waitForIndexWriter(paths);
        return yield* ensureIndex(paths, mode);
      }

      yield* withIndexWriterLease(paths, "rebuild", synchronizeIndex(paths));
      return {
        freshness: "fresh",
        activeWriterObserved: false,
      } satisfies EnsureIndexResult;
    }

    if (mode === "bounded-stale") {
      if (activeWriter) {
        return {
          freshness: "stale",
          activeWriterObserved: true,
        } satisfies EnsureIndexResult;
      }

      const acquired = yield* tryWithIndexWriterLease(paths, "incremental", synchronizeIndex(paths));
      if (acquired === null) {
        return {
          freshness: "stale",
          activeWriterObserved: true,
        } satisfies EnsureIndexResult;
      }

      return {
        freshness: "fresh",
        activeWriterObserved: false,
      } satisfies EnsureIndexResult;
    }

    if (activeWriter) {
      yield* waitForIndexWriter(paths);
      return yield* ensureIndex(paths, mode);
    }

    yield* withIndexWriterLease(paths, "incremental", synchronizeIndex(paths));
    return {
      freshness: "fresh",
      activeWriterObserved: false,
    } satisfies EnsureIndexResult;
  });
}

export function resolvePathsEffect(options: GlobalOptions): Effect.Effect<ResolvedPaths, CliFailure> {
  return resolvePaths(options);
}
