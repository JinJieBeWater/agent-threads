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

const FRESH_INDEX_RESULT = {
  freshness: "fresh",
  activeWriterObserved: false,
} satisfies EnsureIndexResult;

const STALE_INDEX_RESULT = {
  freshness: "stale",
  activeWriterObserved: true,
} satisfies EnsureIndexResult;

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

function waitForWriterAndRetry(
  paths: ResolvedPaths,
  mode: EnsureIndexMode,
): Effect.Effect<EnsureIndexResult, CliFailure> {
  return waitForIndexWriter(paths).pipe(Effect.flatMap(() => ensureIndex(paths, mode)));
}

function ensureUsableIndex(paths: ResolvedPaths): Effect.Effect<EnsureIndexResult, CliFailure> {
  return withIndexWriterLease(paths, "rebuild", synchronizeIndex(paths)).pipe(Effect.as(FRESH_INDEX_RESULT));
}

function ensureBoundedStaleIndex(paths: ResolvedPaths): Effect.Effect<EnsureIndexResult, CliFailure> {
  return tryWithIndexWriterLease(paths, "incremental", synchronizeIndex(paths)).pipe(
    Effect.map((result) => (result === null ? STALE_INDEX_RESULT : FRESH_INDEX_RESULT)),
  );
}

function ensureStrictIndex(paths: ResolvedPaths): Effect.Effect<EnsureIndexResult, CliFailure> {
  return withIndexWriterLease(paths, "incremental", synchronizeIndex(paths)).pipe(Effect.as(FRESH_INDEX_RESULT));
}

export function ensureIndex(paths: ResolvedPaths, mode: EnsureIndexMode): Effect.Effect<EnsureIndexResult, CliFailure> {
  return Effect.gen(function* () {
    if (yield* canSkipIncrementalSync(paths)) {
      return FRESH_INDEX_RESULT;
    }

    const usable = yield* isIndexUsable(paths);
    const activeWriter = yield* readActiveIndexWriter(paths);

    if (!usable) {
      if (activeWriter) {
        return yield* waitForWriterAndRetry(paths, mode);
      }

      return yield* ensureUsableIndex(paths);
    }

    if (mode === "bounded-stale") {
      if (activeWriter) {
        return STALE_INDEX_RESULT;
      }

      return yield* ensureBoundedStaleIndex(paths);
    }

    if (activeWriter) {
      return yield* waitForWriterAndRetry(paths, mode);
    }

    return yield* ensureStrictIndex(paths);
  });
}

export function resolvePathsEffect(options: GlobalOptions): Effect.Effect<ResolvedPaths, CliFailure> {
  return resolvePaths(options);
}
