#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function timestampSlug(date: Date): string {
  return String(date.getTime());
}

const cliArgs = Bun.argv.slice(2);
const sourceRoot = resolve(parseStringFlag(cliArgs, "--source-root", join(homedir(), ".codex")));
const outputRoot = resolve(
  parseStringFlag(cliArgs, "--output-root", join(tmpdir(), `ath-codex-snapshot-${timestampSlug(new Date())}`)),
);
const json = hasFlag(cliArgs, "--json");

mkdirSync(outputRoot, { recursive: true });

const entries = ["state_5.sqlite", "logs_2.sqlite", "session_index.jsonl", "sessions", "archived_sessions"] as const;
const copied: string[] = [];
const skipped: string[] = [];

for (const entry of entries) {
  const from = join(sourceRoot, entry);
  const to = join(outputRoot, entry);
  if (!existsSync(from)) {
    skipped.push(entry);
    continue;
  }
  cpSync(from, to, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
  });
  copied.push(entry);
}

const payload = {
  runtime: "bun",
  sourceRoot,
  outputRoot,
  copied,
  skipped,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(outputRoot);
}
