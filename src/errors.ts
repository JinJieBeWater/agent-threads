import type { CliError, CliSuccess } from "./types.ts";

export class CliFailure extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

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
