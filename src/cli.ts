import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import {
  handleAdmin,
  handleFind,
  handleExportAction,
  handleInspect,
  handleOpen,
  handleRecent,
} from "./handlers.ts";
import { emitEffectResult } from "./output.ts";
import { CliFailure } from "./errors.ts";
import type {
  ExportActionOptions,
  FindActionOptions,
  GlobalOptions,
  OpenActionOptions,
  RecentActionOptions,
} from "./types.ts";

const globalOptionsConfig = {
  json: Options.boolean("json"),
  jsonPretty: Options.boolean("json-pretty"),
  refresh: Options.boolean("refresh"),
  source: Options.optional(Options.text("source")),
  sourceRoot: Options.optional(Options.text("source-root")),
  sourceKind: Options.optional(Options.choice("source-kind", ["codex"])),
  indexDb: Options.optional(Options.text("index-db")),
};

type GlobalCliInput = {
  json: boolean;
  jsonPretty: boolean;
  refresh: boolean;
  source: Option.Option<string>;
  sourceRoot: Option.Option<string>;
  sourceKind: Option.Option<"codex">;
  indexDb: Option.Option<string>;
};

function toGlobalOptions(input: GlobalCliInput): GlobalOptions {
  const source = Option.getOrUndefined(input.source);
  const sourceRoot = Option.getOrUndefined(input.sourceRoot);
  const sourceKind = Option.getOrUndefined(input.sourceKind);
  const indexDb = Option.getOrUndefined(input.indexDb);

  return {
    json: input.json,
    jsonPretty: input.jsonPretty,
    refresh: input.refresh,
    ...(source ? { source } : {}),
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(indexDb ? { indexDb } : {}),
  };
}

function validateIntegerOption(
  value: number,
  label: string,
  validate: (value: number) => boolean,
): Effect.Effect<number, CliFailure> {
  return validate(value)
    ? Effect.succeed(value)
    : Effect.fail(new CliFailure({ code: "invalid-argument", message: `Invalid ${label}.` }));
}

function toExportActionOptions(input: {
  format: ExportActionOptions["format"];
  out: Option.Option<string>;
}): ExportActionOptions {
  return {
    format: input.format,
    out: Option.getOrUndefined(input.out),
  };
}

function toFindActionOptions(input: {
  kind: FindActionOptions["kind"];
  provider: Option.Option<string>;
  cwd: Option.Option<string>;
  role: Option.Option<string>;
  limit: number;
  since: Option.Option<string>;
  until: Option.Option<string>;
}): Effect.Effect<FindActionOptions, CliFailure> {
  return Effect.gen(function* () {
    return {
      kind: input.kind,
      provider: Option.getOrUndefined(input.provider),
      cwd: Option.getOrUndefined(input.cwd),
      role: Option.getOrUndefined(input.role),
      limit: yield* validateIntegerOption(input.limit, "--limit", (value) => value > 0),
      since: Option.getOrUndefined(input.since),
      until: Option.getOrUndefined(input.until),
    };
  });
}

function toRecentActionOptions(input: {
  provider: Option.Option<string>;
  cwd: Option.Option<string>;
  limit: number;
  since: Option.Option<string>;
  until: Option.Option<string>;
}): Effect.Effect<RecentActionOptions, CliFailure> {
  return Effect.gen(function* () {
    return {
      provider: Option.getOrUndefined(input.provider),
      cwd: Option.getOrUndefined(input.cwd),
      limit: yield* validateIntegerOption(input.limit, "--limit", (value) => value > 0),
      since: Option.getOrUndefined(input.since),
      until: Option.getOrUndefined(input.until),
    };
  });
}

function toOpenActionOptions(input: {
  format: OpenActionOptions["format"];
  full: boolean;
  before: number;
  after: number;
}): Effect.Effect<OpenActionOptions, CliFailure> {
  return Effect.gen(function* () {
    return {
      format: input.format,
      full: input.full,
      before: yield* validateIntegerOption(input.before, "--before", (value) => value >= 0),
      after: yield* validateIntegerOption(input.after, "--after", (value) => value >= 0),
    };
  });
}

const findCommand = Command.make(
  "find",
  {
    ...globalOptionsConfig,
    query: Args.text({ name: "query" }),
    kind: Options.choice("kind", ["all", "thread", "message"]).pipe(Options.withDefault("all")),
    provider: Options.optional(Options.text("provider")),
    cwd: Options.optional(Options.text("cwd")),
    role: Options.optional(Options.text("role")),
    limit: Options.integer("limit").pipe(Options.withDefault(20)),
    since: Options.optional(Options.text("since")),
    until: Options.optional(Options.text("until")),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult(
      "find",
      options,
      Effect.gen(function* () {
        const actionOptions = yield* toFindActionOptions(input);
        return yield* handleFind(input.query, actionOptions, options);
      }),
    );
  },
);

const recentCommand = Command.make(
  "recent",
  {
    ...globalOptionsConfig,
    provider: Options.optional(Options.text("provider")),
    cwd: Options.optional(Options.text("cwd")),
    limit: Options.integer("limit").pipe(Options.withDefault(20)),
    since: Options.optional(Options.text("since")),
    until: Options.optional(Options.text("until")),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult(
      "recent",
      options,
      Effect.gen(function* () {
        const actionOptions = yield* toRecentActionOptions(input);
        return yield* handleRecent(actionOptions, options);
      }),
    );
  },
);

const openCommand = Command.make(
  "open",
  {
    ...globalOptionsConfig,
    target: Args.text({ name: "target" }),
    format: Options.choice("format", ["summary", "messages", "jsonl"]).pipe(Options.withDefault("summary")),
    full: Options.boolean("full"),
    before: Options.integer("before").pipe(Options.withDefault(3)),
    after: Options.integer("after").pipe(Options.withDefault(3)),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult(
      "open",
      options,
      Effect.gen(function* () {
        const actionOptions = yield* toOpenActionOptions(input);
        return yield* handleOpen(input.target, actionOptions, options);
      }),
    );
  },
);

const inspectCommand = Command.make(
  "inspect",
  {
    ...globalOptionsConfig,
    subject: Args.text({ name: "subject" }),
    value: Args.optional(Args.text({ name: "value" })),
    related: Options.boolean("related"),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult("inspect", options, handleInspect(input.subject, Option.getOrUndefined(input.value), input.related, options));
  },
);

const exportCommand = Command.make(
  "export",
  {
    ...globalOptionsConfig,
    threadId: Args.text({ name: "threadId" }),
    format: Options.choice("format", ["md", "json"]).pipe(Options.withDefault("md")),
    out: Options.optional(Options.text("out")),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult(
      "export",
      options,
      handleExportAction("thread", input.threadId, toExportActionOptions(input), options),
    );
  },
);

const adminCommand = Command.make(
  "admin",
  {
    ...globalOptionsConfig,
    action: Args.text({ name: "action" }),
    payload: Args.optional(Args.text({ name: "payload" })),
    source: Options.optional(Options.text("source")),
    sourceKind: Options.optional(Options.choice("source-kind", ["codex"])),
  },
  (input) => {
    const options = toGlobalOptions(input);
    return emitEffectResult(
      "admin",
      options,
      handleAdmin(input.action, Option.getOrUndefined(input.payload), {
        ...options,
        ...(Option.isSome(input.source) ? { source: input.source.value } : {}),
        ...(Option.isSome(input.sourceKind) ? { sourceKind: input.sourceKind.value } : {}),
      }),
    );
  },
);

export const command = Command.make("ath", {}).pipe(
  Command.withSubcommands([
    findCommand,
    recentCommand,
    openCommand,
    inspectCommand,
    exportCommand,
    adminCommand,
  ]),
);
