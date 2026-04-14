import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { normalizeCliArgs } from "./argv.ts";
import { command } from "./cli.ts";
import { renderCliHome, renderInspectHome, renderInspectSubcommandHelp, type InspectHelpSubject } from "./render.ts";

const cliName = "ath";
const cliVersion = "0.1.0";
const cli = Command.run(command, {
  name: cliName,
  version: cliVersion,
});
const userArgs = process.argv.slice(2);
const normalizedArgv = normalizeCliArgs(process.argv);
const normalizedUserArgs = normalizedArgv.slice(2);
const inspectSubcommands = new Set<InspectHelpSubject>(["source", "index", "thread", "paths"]);

function isInspectHelpSubject(value: string): value is InspectHelpSubject {
  return inspectSubcommands.has(value as InspectHelpSubject);
}

function shouldRenderInspectHome(args: string[]): boolean {
  if (args[0] !== "inspect") {
    return false;
  }

  const rest = args.slice(1);
  if (rest.length === 0) {
    return true;
  }

  if (rest.some((token) => isInspectHelpSubject(token))) {
    return false;
  }

  return rest.includes("--help") || rest.includes("-h");
}

function getInspectHelpSubject(args: string[]): InspectHelpSubject | null {
  if (args[0] !== "inspect") {
    return null;
  }

  const subject = args[1];
  if (!subject || !isInspectHelpSubject(subject)) {
    return null;
  }

  const rest = args.slice(2);
  return rest.includes("--help") || rest.includes("-h") ? subject : null;
}

const inspectHelpSubject = getInspectHelpSubject(normalizedUserArgs);

if (userArgs.length === 0) {
  process.stdout.write(`${renderCliHome({ name: cliName, version: cliVersion })}\n`);
} else if (inspectHelpSubject) {
  process.stdout.write(
    `${renderInspectSubcommandHelp({
      name: cliName,
      subject: inspectHelpSubject,
    })}\n`,
  );
} else if (shouldRenderInspectHome(normalizedUserArgs)) {
  process.stdout.write(`${renderInspectHome({ name: cliName })}\n`);
} else {
  cli(normalizedArgv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
}
