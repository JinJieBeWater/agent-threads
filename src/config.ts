import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { ConfigFile, GlobalOptions, ResolvedPaths, SourceConfig } from "./types.ts";

const ConfigFileSchema = z.object({
  defaultSource: z.string().optional(),
  indexDb: z.string().optional(),
  sources: z
    .array(
      z.object({
        id: z.string(),
        kind: z.literal("codex"),
        root: z.string(),
      }),
    )
    .optional(),
});

function expandHomePath(input: string): string {
  if (!input.startsWith("~")) {
    return resolve(input);
  }

  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return resolve(join(homedir(), input.slice(2)));
  }

  return resolve(input);
}

function readConfig(configFile: string): ConfigFile {
  if (!existsSync(configFile)) {
    return {};
  }

  try {
    return ConfigFileSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
  } catch {
    return {};
  }
}

function pickValue<T, TSource extends string>(choices: Array<[T | undefined, TSource]>) {
  for (const [value, source] of choices) {
    if (value !== undefined) {
      return { value, source };
    }
  }

  throw new Error("No value candidates were provided.");
}

const DEFAULT_SOURCE_ID = "local-codex";

function findSource(config: ConfigFile, sourceId: string): SourceConfig | undefined {
  return config.sources?.find((source) => source.id === sourceId);
}

export function resolvePaths(options: GlobalOptions): ResolvedPaths {
  const configDir = expandHomePath(
    process.env.AGENT_THREADS_CONFIG_HOME ?? join(homedir(), ".agent-threads"),
  );
  const configFile = join(configDir, "config.json");
  const config = readConfig(configFile);

  const sourceSelection = pickValue<string, ResolvedPaths["configSource"]["sourceSelection"]>([
    [options.source, "flag"],
    [config.defaultSource, "config"],
    [config.sources?.[0]?.id, "config"],
    [DEFAULT_SOURCE_ID, "default"],
  ]);
  const configuredSource = findSource(config, sourceSelection.value);
  const sourceKind = options.sourceKind ?? configuredSource?.kind ?? "codex";
  if (sourceKind !== "codex") {
    throw new Error(`Unsupported source kind: ${sourceKind}`);
  }

  const sourceRootChoice = pickValue<string, ResolvedPaths["configSource"]["sourceRoot"]>([
    [options.sourceRoot, "flag"],
    [configuredSource?.root, "config"],
    [join(homedir(), ".codex"), "default"],
  ]);
  const sourceRoot = expandHomePath(sourceRootChoice.value);

  const indexDbChoice = pickValue<string, ResolvedPaths["configSource"]["indexDb"]>([
    [options.indexDb, "flag"],
    [process.env.AGENT_THREADS_INDEX_DB, "env"],
    [config.indexDb, "config"],
    [join(configDir, "index.sqlite"), "default"],
  ]);

  return {
    sourceId: sourceSelection.value,
    sourceKind,
    sourceRoot,
    stateDb: join(sourceRoot, "state_5.sqlite"),
    logsDb: join(sourceRoot, "logs_2.sqlite"),
    sessionIndex: join(sourceRoot, "session_index.jsonl"),
    sessionsDir: join(sourceRoot, "sessions"),
    archivedSessionsDir: join(sourceRoot, "archived_sessions"),
    indexDb: expandHomePath(indexDbChoice.value),
    configDir,
    configFile,
    configSource: {
      sourceRoot: sourceRootChoice.source,
      sourceSelection: sourceSelection.source,
      indexDb: indexDbChoice.source,
    },
  };
}

export function writeConfigFile(
  paths: ResolvedPaths,
  update: {
    sourceId?: string;
    sourceKind?: "codex";
    sourceRoot?: string;
    indexDb?: string;
  },
): void {
  mkdirSync(paths.configDir, { recursive: true });
  const currentConfig = existsSync(paths.configFile) ? readConfig(paths.configFile) : {};
  const nextSourceId = update.sourceId ?? paths.sourceId;
  const nextSourceKind = update.sourceKind ?? paths.sourceKind;
  const nextSourceRoot = update.sourceRoot ?? paths.sourceRoot;
  const currentSources = currentConfig.sources ?? [];
  const nextSources = [
    ...currentSources.filter((source) => source.id !== nextSourceId),
    {
      id: nextSourceId,
      kind: nextSourceKind,
      root: nextSourceRoot,
    },
  ];

  const nextConfig = {
    ...currentConfig,
    defaultSource: nextSourceId,
    sources: nextSources.sort((left, right) => left.id.localeCompare(right.id)),
    ...(update.indexDb ? { indexDb: update.indexDb } : {}),
  } satisfies ConfigFile;

  writeFileSync(paths.configFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
