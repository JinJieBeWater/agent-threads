import { renderDoctor, renderMessageList, renderStats, renderThreadDetail, renderThreadList } from "./render.ts";
import { asError, asJson } from "./errors.ts";
import type { GlobalOptions } from "./types.ts";

export function printJson(payload: unknown, pretty = false): void {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : undefined)}\n`);
}

export function renderThreadExportMarkdown(
  thread: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
): string {
  const lines = [
    `# ${thread.title ?? "(untitled)"}`,
    "",
    `- Thread ID: ${thread.thread_id}`,
    `- Provider: ${thread.model_provider ?? "-"}`,
    `- CWD: ${thread.cwd ?? "-"}`,
    `- Updated At: ${thread.updated_at ? new Date(Number(thread.updated_at)).toISOString() : "-"}`,
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
  if ((data as Record<string, unknown>).providers) {
    process.stdout.write(`${renderStats(data as Record<string, unknown>)}\n`);
    return;
  }

  if (group === "doctor") {
    process.stdout.write(`${renderDoctor(data as Record<string, unknown>)}\n`);
    return;
  }

  if (group === "threads") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(data)) {
      process.stdout.write(`${renderThreadList(data)}\n`);
      return;
    }
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
  }

  if (group === "messages") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(data)) {
      process.stdout.write(`${renderMessageList(data)}\n`);
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

  if (group === "index") {
    const stats = data as Record<string, unknown>;
    process.stdout.write(
      `Index rebuilt: ${stats.threadCount} threads, ${stats.messageCount} messages, built_at ${stats.builtAt}\n`,
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function emitResult(
  group: string,
  options: GlobalOptions,
  promise: Promise<unknown>,
): Promise<void> {
  try {
    const data = await promise;
    if (options.json) {
      printJson(asJson(data), options.jsonPretty);
      return;
    }
    printHuman(group, data);
  } catch (error) {
    const payload = asError(error);
    if (options.json) {
      printJson(payload, options.jsonPretty);
    } else {
      process.stderr.write(`Error: ${payload.error.message}\n`);
    }
    process.exitCode = 1;
  }
}
