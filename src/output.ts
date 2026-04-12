import { Cause, Effect } from "effect";

import {
  renderDoctor,
  renderFindResults,
  renderMessageList,
  renderRecentResults,
  renderStats,
  renderThreadDetail,
} from "./render.ts";
import { asError, asJson } from "./errors.ts";
import type { GlobalOptions } from "./types.ts";

export function printJson(payload: unknown, pretty = false): void {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : undefined)}\n`);
}

export function renderThreadExportMarkdown(
  thread: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): string {
  const updatedAt =
    typeof thread.updated_at === "number" && Number.isFinite(thread.updated_at) && thread.updated_at > 0
      ? new Date(thread.updated_at < 1_000_000_000_000 ? thread.updated_at * 1_000 : thread.updated_at).toISOString()
      : typeof thread.updated_at === "string" && /^\d+$/.test(thread.updated_at)
        ? new Date(
            Number(thread.updated_at) < 1_000_000_000_000
              ? Number(thread.updated_at) * 1_000
              : Number(thread.updated_at),
          ).toISOString()
        : "-";
  const lines = [
    `# ${thread.title ?? "(untitled)"}`,
    "",
    `- Thread ID: ${thread.thread_id}`,
    `- Provider: ${thread.model_provider ?? "-"}`,
    `- CWD: ${thread.cwd ?? "-"}`,
    `- Updated At: ${updatedAt}`,
    "",
    "## Messages",
    "",
  ];

  for (const message of messages) {
    lines.push(`### #${message.seq} ${message.role ?? "unknown"}`);
    lines.push("");
    lines.push(typeof message.text === "string" ? message.text : "");
    lines.push("");
  }

  return lines.join("\n");
}

export function printHuman(group: string, data: unknown): void {
  if (group === "inspect") {
    const record = data as Record<string, unknown>;
    if (record.sourceId) {
      process.stdout.write(`${renderDoctor(record)}\n`);
      return;
    }
    if (record.providers) {
      process.stdout.write(`${renderStats(record)}\n`);
      return;
    }
    if (record.thread && record.related) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      return;
    }
  }

  if (group === "find") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      process.stdout.write(`${renderFindResults(record.results as Array<Record<string, unknown>>)}\n`);
      return;
    }
  }

  if (group === "recent") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      process.stdout.write(`${renderRecentResults(record.results as Array<Record<string, unknown>>)}\n`);
      return;
    }
  }

  if (group === "open") {
    const record = data as Record<string, unknown>;
    if (record.thread && record.previewMessages) {
      process.stdout.write(
        `${renderThreadDetail(
          record.thread as Record<string, unknown>,
          record.previewMessages as Array<Record<string, unknown>>,
          { truncate: true },
        )}\n`,
      );
      return;
    }
    if (record.thread && record.messages) {
      process.stdout.write(
        `${renderThreadDetail(
          record.thread as Record<string, unknown>,
          record.messages as Array<Record<string, unknown>>,
          {
            truncate: false,
            returnedMessageCount:
              typeof record.returnedMessageCount === "number" ? record.returnedMessageCount : undefined,
            omittedMessageCount:
              typeof record.omittedMessageCount === "number" ? record.omittedMessageCount : undefined,
            truncatedResult: typeof record.truncated === "boolean" ? record.truncated : undefined,
          },
        )}\n`,
      );
      return;
    }
    if (record.messages) {
      process.stdout.write(
        `${renderMessageList(record.messages as Array<Record<string, unknown>>, { truncate: false })}\n`,
      );
      return;
    }
  }

  if (group === "export") {
    const record = data as Record<string, unknown>;
    if (typeof record.contents === "string") {
      process.stdout.write(`${record.contents}\n`);
      return;
    }
  }

  if (group === "admin") {
    const stats = data as Record<string, unknown>;
    if (typeof stats.threadCount === "number" && typeof stats.messageCount === "number") {
      process.stdout.write(
        `Index rebuilt: ${stats.threadCount} threads, ${stats.messageCount} messages, built_at ${stats.builtAt}\n`,
      );
      return;
    }
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function emitEffectResult(
  group: string,
  options: GlobalOptions,
  effect: Effect.Effect<unknown, unknown>,
): Effect.Effect<void> {
  return effect.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.sync(() => {
          const payload = asError(Cause.squash(cause));
          if (options.json) {
            printJson(payload, options.jsonPretty);
          } else {
            process.stderr.write(`Error: ${payload.error.message}\n`);
          }
          process.exitCode = 1;
        }),
      onSuccess: (data) =>
        Effect.sync(() => {
          if (options.json) {
            printJson(asJson(data), options.jsonPretty);
          } else {
            printHuman(group, data);
          }
        }),
    }),
  );
}
