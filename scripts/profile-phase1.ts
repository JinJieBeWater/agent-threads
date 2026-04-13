#!/usr/bin/env bun

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Database } from "bun:sqlite";
import { Effect } from "effect";

import { resolvePaths } from "../src/config.ts";
import { ensureIndex } from "../src/indexer.ts";
import { canSkipIncrementalSync, rebuildIndexUnlocked } from "../src/indexer-sync.ts";
import { searchMessages } from "../src/messages.ts";
import { getThreadStats } from "../src/threads.ts";
import { readSourceFingerprint } from "../src/source/codex.ts";
import type { GlobalOptions, ResolvedPaths } from "../src/types.ts";

type SampleResult = {
  name: string;
  elapsedMs: number;
  details?: Record<string, unknown>;
};

function parseFlag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : fallback;
}

async function timed<T>(name: string, run: () => Promise<T>, details?: (value: T) => Record<string, unknown>): Promise<SampleResult> {
  const startedAt = performance.now();
  const value = await run();
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  return {
    name,
    elapsedMs,
    ...(details ? { details: details(value) } : {}),
  };
}

async function runEffect<T>(effect: Effect.Effect<T, unknown>): Promise<T> {
  return await Effect.runPromise(effect);
}

function resolveCliPaths(sourceRoot: string, indexDb: string): Promise<ResolvedPaths> {
  const options: GlobalOptions = {
    json: true,
    jsonPretty: false,
    refresh: false,
    sourceRoot,
    indexDb,
  };
  return runEffect(resolvePaths(options));
}

async function profileRawInspectQueries(indexDb: string): Promise<SampleResult[]> {
  const db = new Database(indexDb, { readonly: true });
  try {
    const queries: Array<[string, string]> = [
      [
        "inspect_query_messages_table",
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      ],
      [
        "inspect_query_totals",
        `
          SELECT
            COUNT(*) AS thread_count,
            SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_count,
            COALESCE(SUM(message_count), 0) AS indexed_message_count
          FROM threads
        `,
      ],
      ["inspect_query_message_count", `SELECT COUNT(*) AS message_count FROM messages`],
      [
        "inspect_query_providers",
        `
          SELECT model_provider, COUNT(*) AS count
          FROM threads
          GROUP BY model_provider
          ORDER BY count DESC, model_provider ASC
        `,
      ],
      [
        "inspect_query_top_cwds",
        `
          SELECT cwd, COUNT(*) AS count
          FROM threads
          GROUP BY cwd
          ORDER BY count DESC, cwd ASC
          LIMIT 10
        `,
      ],
      ["inspect_query_meta", `SELECT key, value FROM meta`],
    ];

    const results: SampleResult[] = [];
    for (const [name, sql] of queries) {
      const startedAt = performance.now();
      db.query(sql).all();
      results.push({
        name,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

const sourceRoot = resolve(parseFlag("--source-root", join(homedir(), ".codex")));
const indexDb = resolve(parseFlag("--index-db", join(tmpdir(), `ath-phase1-profile-${Date.now()}.sqlite`)));
const outputJson = resolve(
  parseFlag("--output-json", join(process.cwd(), "benchmarks", `phase1-profile-${new Date().toISOString().slice(0, 10)}.json`)),
);

mkdirSync(resolve(process.cwd(), "benchmarks"), { recursive: true });
for (const suffix of ["", "-shm", "-wal", ".lock"]) {
  rmSync(`${indexDb}${suffix}`, { force: true });
}

const payload = await (async () => {
  const paths = await resolveCliPaths(sourceRoot, indexDb);

  const sourceFingerprintBefore = await runEffect(readSourceFingerprint(paths));

  const rebuild = await timed(
    "rebuildIndexUnlocked",
    () => runEffect(rebuildIndexUnlocked(paths)),
    (value) => value as Record<string, unknown>,
  );

  const warmCanSkip = await timed(
    "canSkipIncrementalSync",
    () => runEffect(canSkipIncrementalSync(paths)),
    (value) => ({ canSkip: value }),
  );

  const warmEnsureIndex = await timed("ensureIndex", () => runEffect(ensureIndex(paths, false)));

  const threadStats = await timed(
    "getThreadStats",
    () => runEffect(getThreadStats(paths)),
    (value) => ({
      thread_count: value.thread_count,
      message_count: value.message_count,
    }),
  );

  const notifySearch = await timed(
    "searchMessages_notify_url",
    () =>
      runEffect(
        searchMessages(paths, {
          query: "notify_url",
          limit: 20,
        }),
      ),
    (value) => ({ resultCount: value.length }),
  );

  const paymentSearch = await timed(
    "searchMessages_payment",
    () =>
      runEffect(
        searchMessages(paths, {
          query: "payment",
          limit: 20,
        }),
      ),
    (value) => ({ resultCount: value.length }),
  );

  const rawInspectQueries = await profileRawInspectQueries(indexDb);

  const sourceFingerprintAfter = await runEffect(readSourceFingerprint(paths));

  const artifacts = {
    indexDbBytes: statSync(indexDb).size,
    walBytes: statSync(`${indexDb}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    shmBytes: statSync(`${indexDb}-shm`, { throwIfNoEntry: false })?.size ?? 0,
  };

  return {
    capturedAt: new Date().toISOString(),
    sourceRoot,
    indexDb,
    sourceFingerprintBefore,
    sourceFingerprintAfter,
    samples: [rebuild, warmCanSkip, warmEnsureIndex, threadStats, notifySearch, paymentSearch],
    rawInspectQueries,
    artifacts,
  };
})();

writeFileSync(outputJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify(payload, null, 2));
