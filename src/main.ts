import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { normalizeCliArgs } from "./argv.ts";
import { command } from "./cli.ts";
import { renderCliHome } from "./render.ts";

const cliName = "ath";
const cliVersion = "0.1.0";
const cli = Command.run(command, {
  name: cliName,
  version: cliVersion,
});
const userArgs = process.argv.slice(2);

if (userArgs.length === 0) {
  process.stdout.write(`${renderCliHome({ name: cliName, version: cliVersion })}\n`);
} else {
cli(normalizeCliArgs(process.argv)).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
}
