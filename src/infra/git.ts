import { realpath } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { Effect } from "effect";

import { fileExists } from "./fs.ts";
import { trimTrailingSeparators } from "../path-utils.ts";

export type LiveGitStatus = "verified" | "missing" | "not_git" | "git_error";

export interface LiveGitScopeInfo {
  pathExists: boolean;
  resolvedPath: string | null;
  liveVerified: boolean;
  liveStatus: LiveGitStatus;
  liveRepoScope: string | null;
  liveWorktreeScope: string | null;
  liveError: string | null;
}

function decode(bytes: Uint8Array<ArrayBufferLike> | undefined): string {
  return typeof bytes === "object" ? new TextDecoder().decode(bytes).trim() : "";
}

function classifyNonGit(stderr: string): LiveGitStatus {
  return /not a git repository/i.test(stderr) ? "not_git" : "git_error";
}

export function resolveLiveGitScope(path: string): Effect.Effect<LiveGitScopeInfo, never> {
  return Effect.gen(function* () {
    const pathExists = yield* fileExists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!pathExists) {
      return {
        pathExists: false,
        resolvedPath: null,
        liveVerified: false,
        liveStatus: "missing" as const,
        liveRepoScope: null,
        liveWorktreeScope: null,
        liveError: null,
      };
    }

    const resolvedPath = yield* Effect.tryPromise({
      try: () => realpath(path),
      catch: () => path,
    }).pipe(
      Effect.map((value) => trimTrailingSeparators(value)),
      Effect.catchAll(() => Effect.succeed(trimTrailingSeparators(path))),
    );

    const result = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        path,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = decode(result.stdout);
    const stderr = decode(result.stderr);
    if (result.exitCode !== 0) {
      const liveStatus = classifyNonGit(stderr);
      return {
        pathExists: true,
        resolvedPath,
        liveVerified: false,
        liveStatus,
        liveRepoScope: null,
        liveWorktreeScope: null,
        liveError: liveStatus === "git_error" && stderr.length > 0 ? stderr : null,
      };
    }

    const [topLevel, commonDir] = stdout.split("\n").map((line) => line.trim());
    const liveWorktreeScope = topLevel ? trimTrailingSeparators(topLevel) : null;
    const liveRepoScope =
      commonDir && parse(commonDir).base === ".git" ? trimTrailingSeparators(dirname(commonDir)) : liveWorktreeScope;

    if (!liveWorktreeScope || !liveRepoScope) {
      return {
        pathExists: true,
        resolvedPath,
        liveVerified: false,
        liveStatus: "git_error",
        liveRepoScope: null,
        liveWorktreeScope: null,
        liveError: "Unable to derive Git scopes.",
      };
    }

    return {
      pathExists: true,
      resolvedPath,
      liveVerified: true,
      liveStatus: "verified",
      liveRepoScope,
      liveWorktreeScope,
      liveError: null,
    };
  });
}
