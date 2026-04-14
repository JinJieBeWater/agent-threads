import { parse, resolve } from "node:path";

export function trimTrailingSeparators(value: string): string {
  const root = parse(value).root;
  let normalized = value;

  while (normalized.length > root.length && /[\\/]/.test(normalized.at(-1) ?? "")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export function normalizeAbsolutePath(value: string): string {
  return trimTrailingSeparators(resolve(value));
}
