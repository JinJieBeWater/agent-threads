import { basename } from "node:path";

function formatEpochMs(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return "-";
  }
  return new Date(value).toISOString();
}

function truncate(text: unknown, maxLength = 120): string {
  if (typeof text !== "string") {
    return "";
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}...`;
}

function readMessageText(message: Record<string, unknown>): string {
  return typeof message.text === "string"
    ? message.text
    : typeof message.text_snippet === "string"
      ? message.text_snippet
      : "";
}

export function renderThreadList(threads: Array<Record<string, unknown>>): string {
  if (threads.length === 0) {
    return "No threads matched.";
  }

  return threads
    .map((thread) => {
      const updatedAt = formatEpochMs(thread.updated_at);
      const provider = (thread.model_provider as string | null) ?? "-";
      const cwd = basename((thread.cwd as string | null) ?? "") || "-";
      const title = truncate(thread.title, 160) || "(untitled)";
      return `${thread.thread_id}  [${provider}]  ${updatedAt}  ${cwd}\n  ${title}`;
    })
    .join("\n");
}

export function renderMessageList(
  messages: Array<Record<string, unknown>>,
  options?: {
    truncate?: boolean;
  },
): string {
  if (messages.length === 0) {
    return "No messages matched.";
  }

  const truncateMessages = options?.truncate ?? true;

  return messages
    .map((message) => {
      const seq = String(message.seq ?? "?").padStart(4, " ");
      const role = (message.role as string | null) ?? "unknown";
      const createdAt =
        typeof message.created_at === "string" && message.created_at.length > 0
          ? message.created_at
          : "-";
      const bodySource = readMessageText(message);
      const body = truncateMessages ? truncate(bodySource, 220) : bodySource;
      return `#${seq}  ${role}  ${createdAt}\n${body}`;
    })
    .join("\n\n");
}

export function renderThreadDetail(
  thread: Record<string, unknown>,
  previewMessages: Array<Record<string, unknown>>,
  options?: {
    truncate?: boolean;
    returnedMessageCount?: number;
    omittedMessageCount?: number;
    truncatedResult?: boolean;
  },
): string {
  const headerLines = [
    `thread_id: ${thread.thread_id}`,
    `title: ${thread.title ?? "(untitled)"}`,
    `provider: ${thread.model_provider ?? "-"}`,
    `cwd: ${thread.cwd ?? "-"}`,
    `updated_at: ${formatEpochMs(thread.updated_at)}`,
    `messages: ${thread.message_count ?? 0}`,
  ];

  if (typeof options?.returnedMessageCount === "number") {
    headerLines.push(`returned_messages: ${options.returnedMessageCount}`);
  }
  if (typeof options?.omittedMessageCount === "number") {
    headerLines.push(`omitted_messages: ${options.omittedMessageCount}`);
  }
  if (typeof options?.truncatedResult === "boolean") {
    headerLines.push(`truncated: ${options.truncatedResult ? "yes" : "no"}`);
  }

  const header = headerLines.join("\n");

  if (previewMessages.length === 0) {
    return header;
  }

  return `${header}\n\n${renderMessageList(previewMessages, options)}`;
}

export function renderStats(stats: Record<string, unknown>): string {
  const totals = [
    `threads: ${stats.thread_count ?? 0}`,
    `archived: ${stats.archived_count ?? 0}`,
    `messages: ${stats.message_count ?? 0}`,
  ].join("\n");

  const providers = Array.isArray(stats.providers)
    ? (stats.providers as Array<Record<string, unknown>>)
        .map((row) => `- ${row.model_provider ?? "(null)"}: ${row.count}`)
        .join("\n")
    : "";
  const topCwds = Array.isArray(stats.topCwds)
    ? (stats.topCwds as Array<Record<string, unknown>>)
        .map((row) => `- ${row.cwd ?? "(null)"}: ${row.count}`)
        .join("\n")
    : "";

  return `${totals}\n\nProviders\n${providers || "- none"}\n\nTop CWDs\n${topCwds || "- none"}`;
}

export function renderDoctor(data: Record<string, unknown>): string {
  const lines = [
    `source_id: ${data.sourceId}`,
    `source_kind: ${data.sourceKind}`,
    `source_root: ${data.sourceRoot}`,
    `state_db_exists: ${data.stateDbExists}`,
    `sessions_dir_exists: ${data.sessionsDirExists}`,
    `archived_sessions_dir_exists: ${data.archivedSessionsDirExists}`,
    `session_file_count: ${data.sessionFileCount}`,
    `archived_session_file_count: ${data.archivedSessionFileCount}`,
    `index_db: ${data.indexDb}`,
    `index_exists: ${data.indexExists}`,
    `index_built_at: ${data.indexBuiltAt ?? "-"}`,
    `config_source.source_root: ${data.configSourceRoot}`,
    `config_source.source_selection: ${data.configSourceSelection}`,
    `config_source.indexDb: ${data.configSourceIndexDb}`,
    `auth_required: false`,
    `mode: offline-local`,
  ];

  return lines.join("\n");
}
