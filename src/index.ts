#!/usr/bin/env bun

import { cac } from "cac";
import { z } from "zod";

import {
  handleDoctor,
  handleExportAction,
  handleIndexAction,
  handleInit,
  handleMessagesAction,
  handleRequestAction,
  handleThreadsAction,
} from "./handlers.ts";
import { emitResult } from "./output.ts";
import type { GlobalOptions } from "./types.ts";

const GlobalOptionsSchema = z.object({
  json: z.coerce.boolean().optional().default(false),
  jsonPretty: z.coerce.boolean().optional().default(false),
  refresh: z.coerce.boolean().optional().default(false),
  source: z.string().optional(),
  sourceRoot: z.string().optional(),
  sourceKind: z.enum(["codex"]).optional(),
  indexDb: z.string().optional(),
});

function toGlobalOptions(raw: unknown): GlobalOptions {
  const parsed = GlobalOptionsSchema.parse(raw);
  return {
    json: parsed.json,
    jsonPretty: parsed.jsonPretty,
    refresh: parsed.refresh,
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.sourceRoot ? { sourceRoot: parsed.sourceRoot } : {}),
    ...(parsed.sourceKind ? { sourceKind: parsed.sourceKind } : {}),
    ...(parsed.indexDb ? { indexDb: parsed.indexDb } : {}),
  };
}

const cli = cac("agent-threads");

cli
  .option("--json", "emit machine-readable JSON")
  .option("--json-pretty", "pretty-print JSON output")
  .option("--refresh", "rebuild the local index before running")
  .option("--source <id>", "select a configured history source")
  .option("--source-root <path>", "override the selected source root path")
  .option("--source-kind <kind>", "override the selected source kind")
  .option("--index-db <path>", "override the generated index DB path")
  .help();

cli.version("0.1.0");

cli.command("doctor", "inspect configured history sources and index status").action((rawOptions) => {
  const options = toGlobalOptions(rawOptions);
  return emitResult("doctor", options, handleDoctor(options));
});

cli
  .command("init", "persist agent-threads configuration")
  .option("--source <id>", "persist a source id", { default: "local-codex" })
  .option("--source-kind <kind>", "persist a source kind", { default: "codex" })
  .option("--source-root <path>", "persist a source root path")
  .option("--index-db <path>", "persist a custom index DB path")
  .action((rawOptions) => {
    const options = toGlobalOptions(rawOptions);
    return emitResult("init", options, handleInit(options));
  });

cli.command("index <action>", "manage the local search index").action((action, rawOptions) => {
  const options = toGlobalOptions(rawOptions);
  return emitResult("index", options, handleIndexAction(action, options));
});

cli
  .command("threads <action> [value]", "list, search, inspect, and open thread records")
  .option("--provider <name>", "filter by model provider")
  .option("--cwd <path>", "filter by working directory")
  .option("--limit <n>", "limit result count", { default: 20 })
  .option("--format <format>", "summary|messages|jsonl", { default: "summary" })
  .option("--full", "return the full thread transcript for open --format messages")
  .option("--head <n>", "messages from the start of the thread when not using --full", { default: 4 })
  .option("--tail <n>", "messages from the end of the thread when not using --full", { default: 4 })
  .option("--max-chars <n>", "character budget for open --format messages when not using --full", {
    default: 4000,
  })
  .action((action, value, rawOptions) => {
    const options = toGlobalOptions(rawOptions);
    return emitResult("threads", options, handleThreadsAction(action, value, rawOptions, options));
  });

cli
  .command("messages <action> [value]", "search messages or inspect local context")
  .option("--thread <threadId>", "restrict search to one thread")
  .option("--role <role>", "restrict search to user or assistant")
  .option("--limit <n>", "limit result count", { default: 20 })
  .option("--message <selector>", "message seq or message_ref for context lookup")
  .option("--before <n>", "messages before anchor", { default: 3 })
  .option("--after <n>", "messages after anchor", { default: 3 })
  .action((action, value, rawOptions) => {
    const options = toGlobalOptions(rawOptions);
    return emitResult("messages", options, handleMessagesAction(action, value, rawOptions, options));
  });

cli
  .command("export <kind> <threadId>", "export a thread as markdown or JSON")
  .option("--format <format>", "md|json", { default: "md" })
  .option("--out <path>", "write to a file instead of stdout")
  .action((kind, threadId, rawOptions) => {
    const options = toGlobalOptions(rawOptions);
    return emitResult("export", options, handleExportAction(kind, threadId, rawOptions, options));
  });

cli.command("request <kind> [payload]", "read-only escape hatch").action((kind, payload, rawOptions) => {
  const options = toGlobalOptions(rawOptions);
  return emitResult("request", options, handleRequestAction(kind, payload, options));
});

cli.command("[...args]", "", { hidden: true }).action(() => {
  process.stderr.write(`Error: Unknown command: ${cli.args.join(" ")}\n`);
  cli.outputHelp();
  process.exitCode = 1;
});

cli.parse();
