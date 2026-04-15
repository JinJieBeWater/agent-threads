function formatEpochMs(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const normalized = value < 1_000_000_000_000 ? value * 1_000 : value;
    return new Date(normalized).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      const normalized = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
      return new Date(normalized).toISOString();
    }
  }
  return "-";
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

export function renderCliHome(input: {
  name: string;
  version: string;
}): string {
  const { name, version } = input;
  const commands = [
    ["find <query>", "Search threads and messages"],
    ["recent", "List recently updated threads"],
    ["open <target>", "Open a thread or message context"],
    ["inspect <subcommand>", "Inspect source, index, thread, or paths"],
    ["export <thread-id>", "Export one thread as md or json"],
    ["admin <action>", "Maintenance and read-only SQL"],
  ] as const;
  const commandWidth = Math.max(...commands.map(([usage]) => usage.length));

  return [
    `${name} ${version}`,
    "",
    "Local CLI for searching and reading agent session history.",
    "",
    "Quickstart",
    `  ${name} inspect source`,
    "",
    "Known thread id",
    `  ${name} inspect thread <thread-id> --related`,
    `  ${name} open <thread-id>:12 --before 0 --after 0`,
    "",
    "Fuzzy topic",
    `  ${name} inspect paths --match mercpay`,
    `  ${name} find "error handling" --repo /path/to/repo`,
    `  ${name} recent --repo /path/to/repo --limit 10`,
    "",
    "Commands",
    ...commands.map(([usage, description]) => `  ${usage.padEnd(commandWidth)}  ${description}`),
    "",
    "Help",
    `  ${name} --help`,
    `  ${name} <command> --help`,
  ].join("\n");
}

export function renderInspectHome(input: {
  name: string;
}): string {
  const { name } = input;
  const commands = [
    ["source", "Inspect configured source metadata and storage paths"],
    ["index", "Inspect index stats and provider/cwd summaries"],
    ["thread <thread-id>", "Inspect one thread and optional related threads"],
    ["paths", "Inspect observed paths and recommended query scopes"],
  ] as const;
  const commandWidth = Math.max(...commands.map(([usage]) => usage.length));

  return [
    "inspect",
    "",
    "Inspect source state, index state, one thread, or observed path scopes.",
    "",
    "Subcommands",
    ...commands.map(([usage, description]) => `  ${usage.padEnd(commandWidth)}  ${description}`),
    "",
    "Examples",
    `  ${name} inspect source`,
    `  ${name} inspect index`,
    `  ${name} inspect thread <thread-id> --related`,
    `  ${name} inspect paths --match mercpay`,
    "",
    "Help",
    `  ${name} inspect <subcommand> --help`,
    `  ${name} inspect paths --help`,
  ].join("\n");
}

export type InspectHelpSubject = "source" | "index" | "thread" | "paths";

const inspectGlobalOptions = [
  "--json",
  "--json-pretty",
  "--refresh",
  "--source <id>",
  "--source-root <path>",
  "--source-kind codex",
  "--index-db <path>",
] as const;

export function renderInspectSubcommandHelp(input: {
  name: string;
  subject: InspectHelpSubject;
}): string {
  const { name, subject } = input;

  if (subject === "source") {
    return [
      `inspect ${subject}`,
      "",
      "Inspect configured source metadata, storage paths, and index location.",
      "",
      "Usage",
      `  ${name} inspect source`,
      "",
      "Global Options",
      ...inspectGlobalOptions.map((option) => `  ${option}`),
      "",
      "Examples",
      `  ${name} inspect source`,
      `  ${name} --json inspect source`,
      `  ${name} --source-root ~/.codex inspect source`,
    ].join("\n");
  }

  if (subject === "index") {
    return [
      `inspect ${subject}`,
      "",
      "Inspect index stats, provider counts, and top observed cwd summaries.",
      "",
      "Usage",
      `  ${name} inspect index`,
      "",
      "Global Options",
      ...inspectGlobalOptions.map((option) => `  ${option}`),
      "",
      "Examples",
      `  ${name} inspect index`,
      `  ${name} --json inspect index`,
      `  ${name} --refresh inspect index`,
    ].join("\n");
  }

  if (subject === "thread") {
    return [
      `inspect ${subject}`,
      "",
      "Inspect one thread and optionally include related threads from the same cwd.",
      "",
      "Usage",
      `  ${name} inspect thread <thread-id>`,
      `  ${name} inspect thread <thread-id> --related`,
      "",
      "Global Options",
      ...inspectGlobalOptions.map((option) => `  ${option}`),
      "",
      "Local Options",
      "  --related",
      "",
      "Examples",
      `  ${name} inspect thread 019d8985-6fa4-7792-b92c-4fcc008b212f`,
      `  ${name} --json inspect thread 019d8985-6fa4-7792-b92c-4fcc008b212f --related`,
    ].join("\n");
  }

  return [
    `inspect ${subject}`,
    "",
    "Inspect observed cwd rows and the recommended query scope for follow-up find/recent calls.",
    "",
    "Usage",
    `  ${name} inspect paths`,
    `  ${name} inspect paths --match mercpay`,
    `  ${name} inspect paths --repo /path/to/repo`,
    "",
    "Global Options",
    ...inspectGlobalOptions.map((option) => `  ${option}`),
    "",
    "Local Options",
    "  --match <text>",
    "  --cwd <path>",
    "  --repo <path>",
    "  --worktree <path>",
    "  --limit <n>",
    "",
    "Notes",
    "  If you already know the exact thread id, use `inspect thread` instead.",
    "  Scope flags here filter observed path rows only.",
    "  Use the chosen scope with `find` or `recent` for actual history queries.",
    "",
    "Examples",
    `  ${name} inspect paths --match mercpay`,
    `  ${name} inspect paths --repo /Users/me/src/mercpay`,
    `  ${name} find "payment callback" --repo /Users/me/src/mercpay --kind message`,
  ].join("\n");
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

export function renderFindResults(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) {
    return "No results matched.";
  }

  return results
    .map((result) => {
      const kind = result.kind === "message" ? "message" : "thread";
      const target = typeof result.target === "string" ? result.target : "-";
      const title = truncate(result.title, 140) || "(untitled)";
      const snippet = truncate(result.snippet, 220);
      const timestamp =
        typeof result.updated_at === "string"
          ? result.updated_at
          : typeof result.created_at === "string"
            ? result.created_at
            : "-";
      return `[${kind}] ${target}\n${title}\n${snippet}${snippet ? "\n" : ""}${timestamp}`;
    })
    .join("\n\n");
}

export function renderRecentResults(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) {
    return "No recent threads matched.";
  }

  return results
    .map((result) => {
      const target = typeof result.target === "string" ? result.target : "-";
      const firstUserMessage = truncate(result.first_user_message, 220);
      const title = truncate(result.title, 140);
      const summary = firstUserMessage || title || "(untitled)";
      const timestamp = typeof result.updated_at === "string" ? result.updated_at : "-";
      return `[thread] ${target}\n${summary}\n${timestamp}`;
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

export function renderObservedPaths(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) {
    return "No session paths matched.";
  }

  return results
    .map((result) => {
      const pathKind = typeof result.path_kind === "string" ? result.path_kind : "cwd";
      const cwd = typeof result.cwd === "string" ? result.cwd : "-";
      const threadCount = Number(result.thread_count ?? 0);
      const lastUpdatedAt = typeof result.last_updated_at === "string" ? result.last_updated_at : "-";
      const liveStatus = typeof result.live_status === "string" ? result.live_status : "unknown";
      const recommendedScope =
        result.recommended_scope && typeof result.recommended_scope === "object"
          ? (result.recommended_scope as Record<string, unknown>)
          : null;
      const scopeFlag = typeof recommendedScope?.flag === "string" ? recommendedScope.flag : "--cwd";
      const scopeValue = typeof recommendedScope?.value === "string" ? recommendedScope.value : cwd;
      const branch = typeof result.sample_branch === "string" ? result.sample_branch : null;
      const origin = typeof result.sample_origin === "string" ? result.sample_origin : null;
      const details = [
        `threads: ${threadCount}`,
        `updated: ${lastUpdatedAt}`,
        `live: ${liveStatus}`,
        `scope: ${scopeFlag} ${scopeValue}`,
      ];
      if (branch) {
        details.push(`branch: ${branch}`);
      }
      if (origin) {
        details.push(`origin: ${origin}`);
      }
      return `[${pathKind}] ${cwd}\n${details.join("  ")}`;
    })
    .join("\n\n");
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
