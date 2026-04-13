#!/usr/bin/env bun

import { cpus, homedir, tmpdir, totalmem, uptime } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

type BenchmarkCase = {
  name: string;
  description: string;
  commandArgs: string[];
  mode: "cold" | "warm";
  samples: number;
};

type BenchmarkSample = {
  sample: number;
  elapsedMs: number;
};

type BenchmarkResult = {
  name: string;
  description: string;
  command: string[];
  mode: "cold" | "warm";
  samples: BenchmarkSample[];
  summary: {
    minMs: number;
    medianMs: number;
    meanMs: number;
    maxMs: number;
  };
};

type InspectIndexPayload = {
  ok: true;
  data: {
    thread_count: number;
    message_count: number;
    indexed_message_count: number;
    meta: Record<string, string>;
  };
};

function parseNumberFlag(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid value for ${flag}: ${args[index + 1] ?? ""}`);
  }
  return value;
}

function parseStringFlag(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]!;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildSummary(samples: BenchmarkSample[]) {
  const values = samples.map((sample) => sample.elapsedMs);
  return {
    minMs: roundMs(Math.min(...values)),
    medianMs: roundMs(median(values)),
    meanMs: roundMs(mean(values)),
    maxMs: roundMs(Math.max(...values)),
  };
}

function runCli(cliEntry: string, sourceRoot: string, indexDb: string, commandArgs: string[]) {
  const cmd = [process.execPath, cliEntry, "--json", "--source-root", sourceRoot, "--index-db", indexDb, ...commandArgs];
  const startedAt = performance.now();
  const processResult = Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  const elapsedMs = performance.now() - startedAt;
  const stdout = processResult.stdout.toString("utf8");
  const stderr = processResult.stderr.toString("utf8");

  if (processResult.exitCode !== 0) {
    throw new Error(
      [
        `Command failed with exit code ${processResult.exitCode}`,
        cmd.join(" "),
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return { cmd, elapsedMs: roundMs(elapsedMs), stdout, stderr };
}

const cliArgs = Bun.argv.slice(2);
const cliEntry = resolve(import.meta.dir, "..", "src", "index.ts");
const repoRoot = resolve(import.meta.dir, "..");
const sourceRoot = parseStringFlag(cliArgs, "--source-root", join(homedir(), ".codex"));
const coldSamples = parseNumberFlag(cliArgs, "--cold-samples", 2);
const warmSamples = parseNumberFlag(cliArgs, "--warm-samples", 3);
const outputJson = resolve(
  parseStringFlag(
    cliArgs,
    "--output-json",
    join(repoRoot, "benchmarks", `baseline-${new Date().toISOString().slice(0, 10)}.json`),
  ),
);

mkdirSync(dirname(outputJson), { recursive: true });

const benchmarkRoot = mkdtempSync(join(tmpdir(), "ath-benchmark-"));
const warmIndexDb = join(benchmarkRoot, "warm-index.sqlite");

const cases: BenchmarkCase[] = [
  {
    name: "cold_inspect_index",
    description: "First read on an empty temp index; includes initial index build.",
    commandArgs: ["inspect", "index"],
    mode: "cold",
    samples: coldSamples,
  },
  {
    name: "warm_inspect_index",
    description: "Read-only stats on a warm index; includes no-op sync preflight.",
    commandArgs: ["inspect", "index"],
    mode: "warm",
    samples: warmSamples,
  },
  {
    name: "warm_recent_limit_20",
    description: "Recent threads listing on a warm index.",
    commandArgs: ["recent", "--limit", "20"],
    mode: "warm",
    samples: warmSamples,
  },
  {
    name: "warm_find_message_notify_url",
    description: "Identifier-style message search on a warm index.",
    commandArgs: ["find", "notify_url", "--kind", "message", "--limit", "20"],
    mode: "warm",
    samples: warmSamples,
  },
  {
    name: "warm_find_message_payment",
    description: "High-frequency English token search on a warm index.",
    commandArgs: ["find", "payment", "--kind", "message", "--limit", "20"],
    mode: "warm",
    samples: warmSamples,
  },
  {
    name: "warm_find_message_epay_callback",
    description: "Two-token phrase-style search on a warm index.",
    commandArgs: ["find", "epay callback", "--kind", "message", "--limit", "20"],
    mode: "warm",
    samples: warmSamples,
  },
  {
    name: "admin_reindex",
    description: "Explicit full rebuild against an existing temp index.",
    commandArgs: ["admin", "reindex"],
    mode: "warm",
    samples: warmSamples,
  },
];

try {
  const setupResult = runCli(cliEntry, sourceRoot, warmIndexDb, ["inspect", "index"]);
  const warmInspect = JSON.parse(setupResult.stdout) as InspectIndexPayload;
  const readyIndexStats = warmInspect.data;

  const benchmarkResults: BenchmarkResult[] = [];

  for (const benchmarkCase of cases) {
    const samples: BenchmarkSample[] = [];

    for (let sampleIndex = 0; sampleIndex < benchmarkCase.samples; sampleIndex += 1) {
      const indexDb =
        benchmarkCase.mode === "cold"
          ? join(benchmarkRoot, `${benchmarkCase.name}-${sampleIndex + 1}.sqlite`)
          : warmIndexDb;

      if (benchmarkCase.mode === "cold") {
        for (const suffix of ["", "-shm", "-wal", ".lock"]) {
          rmSync(`${indexDb}${suffix}`, { force: true });
        }
      }

      const result = runCli(cliEntry, sourceRoot, indexDb, benchmarkCase.commandArgs);
      samples.push({
        sample: sampleIndex + 1,
        elapsedMs: result.elapsedMs,
      });
    }

    benchmarkResults.push({
      name: benchmarkCase.name,
      description: benchmarkCase.description,
      command: benchmarkCase.commandArgs,
      mode: benchmarkCase.mode,
      samples,
      summary: buildSummary(samples),
    });
  }

  const warmIndexArtifacts = {
    indexDbBytes: statSync(warmIndexDb).size,
    walBytes: statSync(`${warmIndexDb}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    shmBytes: statSync(`${warmIndexDb}-shm`, { throwIfNoEntry: false })?.size ?? 0,
  };

  const payload = {
    capturedAt: new Date().toISOString(),
    cliEntry,
    sourceRoot,
    benchmarkRoot,
    environment: {
      runtime: "bun",
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      systemUptimeSeconds: Math.round(uptime()),
    },
    dataset: {
      threadCount: readyIndexStats.thread_count,
      messageCount: readyIndexStats.message_count,
      indexedMessageCount: readyIndexStats.indexed_message_count,
      sourceBuiltAt: readyIndexStats.meta.built_at ?? "",
    },
    warmIndexArtifacts,
    notes: [
      "All command timings are end-to-end CLI wall-clock measurements.",
      "Warm-command timings still include ensureIndex() and its no-op sync preflight.",
      "Cold inspect-index timings include initial schema setup and index build into a fresh temp SQLite file.",
      "The benchmark uses the caller's current source root and a temp benchmark index, so it does not mutate ~/.agent-threads/index.sqlite.",
    ],
    cases: benchmarkResults,
  };

  writeFileSync(outputJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
} finally {
  rmSync(benchmarkRoot, { recursive: true, force: true });
}
