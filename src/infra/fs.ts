import { BunFileSystem } from "@effect/platform-bun";
import * as FileSystem from "@effect/platform/FileSystem";
import { writeFile } from "node:fs/promises";
import { Effect, Option } from "effect";

import { CliFailure } from "../errors.ts";

const encoder = new TextEncoder();

function fsError(code: string, message: string) {
  return () => new CliFailure({ code, message });
}

export function fileExists(path: string): Effect.Effect<boolean, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.exists(path).pipe(Effect.mapError(fsError("fs-exists-failed", `Unable to check path: ${path}`))),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function readFileString(path: string): Effect.Effect<string, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(path).pipe(Effect.mapError(fsError("fs-read-failed", `Unable to read file: ${path}`))),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function writeFileString(path: string, contents: string): Effect.Effect<void, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(path, contents).pipe(
      Effect.mapError(fsError("fs-write-failed", `Unable to write file: ${path}`)),
    ),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function makeDirectory(path: string): Effect.Effect<void, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeDirectory(path, { recursive: true }).pipe(
      Effect.mapError(fsError("fs-mkdir-failed", `Unable to create directory: ${path}`)),
    ),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function readDirectory(path: string): Effect.Effect<Array<string>, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readDirectory(path).pipe(Effect.mapError(fsError("fs-readdir-failed", `Unable to read directory: ${path}`))),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function readModifiedTime(path: string): Effect.Effect<number | null, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => {
        const mtime = Option.getOrUndefined(info.mtime);
        return mtime ? mtime.getTime() : null;
      }),
      Effect.mapError(fsError("fs-stat-failed", `Unable to stat path: ${path}`)),
    ),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function readFileStats(
  path: string,
): Effect.Effect<{ sizeBytes: number; mtimeMs: number | null }, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => {
        const mtime = Option.getOrUndefined(info.mtime);
        return {
          sizeBytes: Number(info.size ?? 0),
          mtimeMs: mtime ? mtime.getTime() : null,
        };
      }),
      Effect.mapError(fsError("fs-stat-failed", `Unable to stat path: ${path}`)),
    ),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function removeFile(path: string): Effect.Effect<void, CliFailure> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.remove(path, { force: true }).pipe(
      Effect.mapError(fsError("fs-remove-failed", `Unable to remove path: ${path}`)),
    ),
  ).pipe(Effect.provide(BunFileSystem.layer));
}

export function ensureParentDirectory(path: string): Effect.Effect<void, CliFailure> {
  const index = path.lastIndexOf("/");
  const directory = index >= 0 ? path.slice(0, index) : ".";
  return makeDirectory(directory.length > 0 ? directory : ".");
}

export function writeExclusiveFile(path: string, contents: string): Effect.Effect<void, CliFailure> {
  return Effect.tryPromise({
    try: async () => {
      await writeFile(path, encoder.encode(contents), { flag: "wx" });
    },
    catch: (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return new CliFailure({
          code: "fs-already-exists",
          message: `Path already exists: ${path}`,
        });
      }
      return new CliFailure({
        code: "fs-open-failed",
        message: `Unable to open file: ${path}`,
      });
    },
  });
}
