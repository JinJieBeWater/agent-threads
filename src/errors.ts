import { Schema } from "effect";

import type { CliError, CliSuccess } from "./types.ts";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  code: Schema.String,
  message: Schema.String,
}) {}

export function asJson<T>(data: T): CliSuccess<T> {
  return { ok: true, data };
}

export function asError(error: unknown): CliError {
  if (error instanceof CliFailure) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "unexpected-error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
