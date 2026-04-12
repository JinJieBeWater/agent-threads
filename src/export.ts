import { Effect } from "effect";

import { CliFailure } from "./errors.ts";
import { ensureParentDirectory, fileExists, readFileString, writeFileString } from "./infra/fs.ts";
import { renderThreadExportMarkdown } from "./output.ts";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

export function exportThreadData(input: {
  threadId: string;
  format: "md" | "json";
  thread: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  outPath?: string;
}): Effect.Effect<Record<string, unknown>, CliFailure> {
  const contents =
    input.format === "json"
      ? JSON.stringify({ thread: input.thread, messages: input.messages }, null, 2)
      : renderThreadExportMarkdown(input.thread, input.messages);

  if (input.outPath) {
    const outPath = input.outPath;
    return Effect.gen(function* () {
      yield* ensureParentDirectory(outPath).pipe(
        Effect.mapError(
          () =>
            new CliFailure({
              code: "export-write-failed",
              message: `Unable to write export file: ${outPath}`,
            }),
        ),
      );
      yield* writeFileString(outPath, `${contents}\n`).pipe(
        Effect.mapError(
          () =>
            new CliFailure({
              code: "export-write-failed",
              message: `Unable to write export file: ${outPath}`,
            }),
        ),
      );
      return {
        threadId: input.threadId,
        format: input.format,
        out: outPath,
        bytes: Buffer.byteLength(contents, "utf8"),
      };
    });
  }

  return Effect.succeed({
    threadId: input.threadId,
    format: input.format,
    contents,
  });
}

export function readRawJsonl(thread: Record<string, unknown>): Effect.Effect<{
  path: string;
  contents: string;
} | null, CliFailure> {
  return Effect.gen(function* () {
    const sourceFile = firstString(thread.source_file, thread.rollout_path);
    if (!sourceFile) {
      return null;
    }
    const exists = yield* fileExists(sourceFile);
    if (!exists) {
      return null;
    }

    return {
      path: sourceFile,
      contents: yield* readFileString(sourceFile),
    };
  });
}
