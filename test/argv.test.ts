import { expect, test } from "bun:test";

import { normalizeCliArgs } from "../src/argv.ts";

test("normalizeCliArgs leaves argv unchanged when the command is already in place", () => {
  const argv = ["bun", "/tmp/ath.ts", "inspect", "source", "--json"];

  expect(normalizeCliArgs(argv)).toEqual(argv);
});

test("normalizeCliArgs hoists supported global options before the command", () => {
  const argv = ["bun", "/tmp/ath.ts", "--source-root", "/tmp/codex", "--json", "inspect", "source"];

  expect(normalizeCliArgs(argv)).toEqual([
    "bun",
    "/tmp/ath.ts",
    "inspect",
    "source",
    "--source-root",
    "/tmp/codex",
    "--json",
  ]);
});

test("normalizeCliArgs preserves = syntax for global value options", () => {
  const argv = [
    "bun",
    "/tmp/ath.ts",
    "--source-root=/tmp/codex",
    "--index-db=/tmp/index.sqlite",
    "inspect",
    "source",
  ];

  expect(normalizeCliArgs(argv)).toEqual([
    "bun",
    "/tmp/ath.ts",
    "inspect",
    "source",
    "--source-root=/tmp/codex",
    "--index-db=/tmp/index.sqlite",
  ]);
});

test("normalizeCliArgs leaves argv unchanged when a global value option is missing its value", () => {
  const argv = ["bun", "/tmp/ath.ts", "--source-root", "inspect", "source"];

  expect(normalizeCliArgs(argv)).toEqual(argv);
});
