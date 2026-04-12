export type MessageRole = "user" | "assistant" | "system" | "unknown";

export interface GlobalOptions {
  json: boolean;
  jsonPretty: boolean;
  refresh: boolean;
  source?: string;
  sourceRoot?: string;
  sourceKind?: "codex";
  indexDb?: string;
}

export type ThreadOpenFormat = "summary" | "messages" | "jsonl";
export type ExportFormat = "md" | "json";

export interface ExportActionOptions {
  format: ExportFormat;
  out?: string;
}

export type FindKind = "all" | "thread" | "message";

export interface FindActionOptions {
  kind: FindKind;
  provider?: string;
  cwd?: string;
  role?: string;
  limit: number;
  since?: string;
  until?: string;
}

export interface RecentActionOptions {
  provider?: string;
  cwd?: string;
  limit: number;
  since?: string;
  until?: string;
}

export interface OpenActionOptions {
  format: ThreadOpenFormat;
  full: boolean;
  before: number;
  after: number;
}

export interface SourceConfig {
  id: string;
  kind: "codex";
  root: string;
}

export interface ConfigFile {
  defaultSource?: string;
  indexDb?: string;
  sources?: readonly SourceConfig[];
}

export interface ResolvedPaths {
  sourceId: string;
  sourceKind: "codex";
  sourceRoot: string;
  stateDb: string;
  logsDb: string;
  sessionIndex: string;
  sessionsDir: string;
  archivedSessionsDir: string;
  indexDb: string;
  configDir: string;
  configFile: string;
  configSource: {
    sourceRoot: "flag" | "config" | "default";
    sourceSelection: "flag" | "config" | "default";
    indexDb: "flag" | "env" | "config" | "default";
  };
}

export interface ThreadRecord {
  threadId: string;
  rolloutPath: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  source: string | null;
  modelProvider: string | null;
  cwd: string | null;
  title: string | null;
  sandboxPolicy: string | null;
  approvalMode: string | null;
  tokensUsed: number | null;
  archived: number;
  archivedAt: number | null;
  gitSha: string | null;
  gitBranch: string | null;
  gitOriginUrl: string | null;
  cliVersion: string | null;
  firstUserMessage: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  memoryMode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentPath: string | null;
  sourceFile: string | null;
  sourceKind: "state" | "session" | "archived";
  fileExists: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  lastMessageAt: string | null;
}

export interface MessageRecord {
  threadId: string;
  seq: number;
  messageRef: string;
  role: MessageRole;
  kind: string;
  phase: string | null;
  text: string;
  createdAt: string | null;
  sourceFile: string;
  sourceLine: number;
}

export interface ParsedSessionFile {
  threadId: string;
  meta: Partial<ThreadRecord>;
  messages: MessageRecord[];
}

export interface CliSuccess<T> {
  ok: true;
  data: T;
}

export interface CliError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}
