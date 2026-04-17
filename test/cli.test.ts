import { chmodSync, readFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cliEntry = join(projectRoot, "src", "index.ts");
const fixtureSession = readFileSync(join(projectRoot, "test", "fixtures", "sample-session.jsonl"), "utf8");
const cliWarmup = spawnSync("bun", ["run", cliEntry, "--version"], {
  cwd: projectRoot,
  encoding: "utf8",
});

if (cliWarmup.status !== 0) {
  throw new Error(`CLI warmup failed: ${cliWarmup.stderr}`);
}

function runGit(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeLiveGitRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-threads-git-scope-"));
  const repoRoot = join(root, "scoped-project");
  mkdirSync(join(repoRoot, "packages", "app"), { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), "scoped project\n", "utf8");

  runGit(["init", repoRoot]);
  runGit(["config", "user.name", "Test User"], repoRoot);
  runGit(["config", "user.email", "test@example.com"], repoRoot);
  runGit(["add", "."], repoRoot);
  runGit(["commit", "-m", "init"], repoRoot);

  const worktreeRoot = `${repoRoot}.worktrees/feat-a`;
  runGit(["worktree", "add", "-b", "feat-a", worktreeRoot], repoRoot);
  mkdirSync(join(worktreeRoot, "apps", "web"), { recursive: true });
  writeFileSync(join(worktreeRoot, "apps", "web", "feature.txt"), "feat\n", "utf8");

  return {
    repoRoot,
    worktreeRoot,
  };
}

function createEmptyThreadsTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled',
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT
      );
    `);
  } finally {
    db.close();
  }
}

function createThreadsTable(
  dbPath: string,
  options?: {
    createdAt?: number;
    updatedAt?: number;
  },
): void {
  createEmptyThreadsTable(dbPath);
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO threads (
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        archived,
        cli_version,
        first_user_message,
        model,
        reasoning_effort
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "thread-epay-fix",
      join(dirname(dbPath), "sessions", "2026", "04", "11", "rollout-thread-epay-fix.jsonl"),
      options?.createdAt ?? 1_744_338_552_000,
      options?.updatedAt ?? 1_744_338_610_000,
      "cli",
      "Spencer",
      "/tmp/mercpay",
      "The following is the Codex agent history whose request action you are assessing. >>> TRANSCRIPT START [1] user: noisy title",
      "workspace-write",
      "on-request",
      1234,
      0,
      "0.118.0",
      "How should I normalize notify_url for epay callbacks?",
      "gpt-5.4",
      "high",
    );
  } finally {
    db.close();
  }
}

function makeFakeSourceRoot(): string {
  return makeFakeSourceRootWithThreadTimes();
}

function seedLogsDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL,
        target TEXT NOT NULL,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.query(
      `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1_744_338_610,
      0,
      "INFO",
      "test",
      "seeded activity",
      "",
      "",
      0,
      "thread-epay-fix",
      "test-process",
      16,
    );
  } finally {
    db.close();
  }
}

function makeTrustedManifestSourceRoot(): string {
  const root = makeFakeSourceRoot();
  seedLogsDb(join(root, "logs_2.sqlite"));
  return root;
}

function appendLogRow(logsDbPath: string, threadId: string): void {
  const db = new Database(logsDbPath);
  try {
    db.query(
      `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Math.floor(Date.now() / 1000),
      0,
      "INFO",
      "test",
      "synthetic activity",
      "",
      "",
      0,
      threadId,
      "test-process",
      16,
    );
  } finally {
    db.close();
  }
}

function makeFakeSourceRootWithThreadTimes(options?: {
  createdAt?: number;
  updatedAt?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-threads-test-"));
  mkdirSync(join(root, "sessions", "2026", "04", "11"), { recursive: true });
  mkdirSync(join(root, "archived_sessions"), { recursive: true });

  const sessionPath = join(root, "sessions", "2026", "04", "11", "rollout-thread-epay-fix.jsonl");
  writeFileSync(sessionPath, `${fixtureSession}\n`, "utf8");
  writeSessionIndex(root, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    },
  ]);
  createThreadsTable(join(root, "state_5.sqlite"), options);
  writeFileSync(join(root, "logs_2.sqlite"), "", "utf8");
  return root;
}

function makeSourceRootWithoutSessionMeta(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-threads-no-meta-"));
  mkdirSync(join(root, "sessions", "2026", "04", "11"), { recursive: true });
  mkdirSync(join(root, "archived_sessions"), { recursive: true });

  const threadId = "019d78b3-f25e-7703-af77-6e0c9897699e";
  const sessionPath = join(
    root,
    "sessions",
    "2026",
    "04",
    "11",
    `rollout-2026-04-11T02-42-32-${threadId}.jsonl`,
  );
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        timestamp: "2026-04-11T02:42:40.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Find the old payment callback fix.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:42:55.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final_answer",
          message: "Search old sessions by message content, not only by title.",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "session_index.jsonl"), "", "utf8");
  writeFileSync(join(root, "logs_2.sqlite"), "", "utf8");
  return root;
}

function makeSourceRootFromSessionFile(fileName: string, contents: string): string {
  return makeSourceRootFromSessionFiles([{ fileName, contents }]);
}

function makeSourceRootFromSessionFiles(
  sessions: Array<{
    fileName: string;
    contents: string;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "agent-threads-generic-"));
  mkdirSync(join(root, "sessions", "2026", "04", "11"), { recursive: true });
  mkdirSync(join(root, "archived_sessions"), { recursive: true });

  for (const session of sessions) {
    writeFileSync(join(root, "sessions", "2026", "04", "11", session.fileName), session.contents, "utf8");
  }
  writeFileSync(join(root, "session_index.jsonl"), "", "utf8");
  writeFileSync(join(root, "logs_2.sqlite"), "", "utf8");
  createEmptyThreadsTable(join(root, "state_5.sqlite"));
  return root;
}

function createLegacyReadyIndexDb(
  sourceRoot: string,
  indexDb: string,
  options?: {
    threadId?: string;
    updatedAt?: number;
    title?: string;
    firstUserMessage?: string;
  },
): void {
  mkdirSync(dirname(indexDb), { recursive: true });
  const db = new Database(indexDb);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        model_provider TEXT,
        cwd TEXT,
        title TEXT,
        sandbox_policy TEXT,
        approval_mode TEXT,
        tokens_used INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT,
        first_user_message TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT,
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT,
        source_file TEXT,
        source_kind TEXT NOT NULL,
        file_exists INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT
      );
    `);
    db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("built_at", "2026-04-12T00:00:00.000Z");
    db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("source_id", "local-codex");
    db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("source_kind", "codex");
    db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("source_root", sourceRoot);
    db.query(`
      INSERT INTO threads (
        thread_id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        archived,
        archived_at,
        git_sha,
        git_branch,
        git_origin_url,
        cli_version,
        first_user_message,
        agent_nickname,
        agent_role,
        memory_mode,
        model,
        reasoning_effort,
        agent_path,
        source_file,
        source_kind,
        file_exists,
        message_count,
        user_message_count,
        assistant_message_count,
        last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options?.threadId ?? "legacy-seconds",
      join(sourceRoot, "sessions", "2026", "04", "11", "rollout-legacy-seconds.jsonl"),
      1_744_338_552,
      options?.updatedAt ?? 1_744_338_610,
      "cli",
      "rightcode",
      sourceRoot,
      options?.title ?? "legacy title",
      "workspace-write",
      "on-request",
      0,
      0,
      0,
      "",
      "",
      "",
      "0.1.0",
      options?.firstUserMessage ?? "legacy summary",
      "",
      "",
      "",
      "",
      "",
      "",
      join(sourceRoot, "sessions", "2026", "04", "11", "rollout-legacy-seconds.jsonl"),
      "state",
      1,
      1,
      1,
      0,
      "2026-04-11T02:30:10.000Z",
    );
  } finally {
    db.close();
  }
}

function runCli(args: string[], sourceRoot: string, indexDb: string) {
  return spawnSync(
    "bun",
    [
      "run",
      cliEntry,
      "--source-root",
      sourceRoot,
      "--index-db",
      indexDb,
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );
}

function runCliAsync(args: string[], sourceRoot: string, indexDb: string) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      [
        "run",
        cliEntry,
        "--source-root",
        sourceRoot,
        "--index-db",
        indexDb,
        ...args,
      ],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function runRawCli(args: string[]) {
  return spawnSync("bun", ["run", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

function makeSessionJsonl(input: {
  threadId: string;
  title: string;
  cwd?: string;
  provider?: string;
  messages: Array<{
    timestamp: string;
    role: "user" | "assistant";
    text: string;
  }>;
}) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: input.threadId,
        cwd: input.cwd ?? "/tmp/project",
        source: "cli",
        model_provider: input.provider ?? "Spencer",
        thread_name: input.title,
      },
    }),
    ...input.messages.map((message) =>
      JSON.stringify({
        timestamp: message.timestamp,
        type: "event_msg",
        payload: {
          type: message.role === "user" ? "user_message" : "agent_message",
          ...(message.role === "assistant" ? { phase: "final_answer" } : {}),
          message: message.text,
        },
      }),
    ),
    "",
  ].join("\n");
}

function makeSessionMetaOnlyJsonl(input: {
  threadId: string;
  title: string;
  cwd?: string;
  provider?: string;
}) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: input.threadId,
        cwd: input.cwd ?? "/tmp/project",
        source: "cli",
        model_provider: input.provider ?? "Spencer",
        thread_name: input.title,
      },
    }),
    "",
  ].join("\n");
}

function writeSessionIndex(
  root: string,
  entries: Array<{
    id: string;
    thread_name: string;
    updated_at: string;
  }>,
) {
  writeFileSync(
    join(root, "session_index.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf8",
  );
}

function getDefaultSessionPath(root: string) {
  return join(root, "sessions", "2026", "04", "11", "rollout-thread-epay-fix.jsonl");
}

function updateStateThread(dbPath: string, threadId: string, patch: { title?: string; updatedAt?: number; archived?: number }) {
  const db = new Database(dbPath);
  try {
    if (patch.title !== undefined) {
      db.query(`UPDATE threads SET title = ? WHERE id = ?`).run(patch.title, threadId);
    }
    if (patch.updatedAt !== undefined) {
      db.query(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(patch.updatedAt, threadId);
    }
    if (patch.archived !== undefined) {
      db.query(`UPDATE threads SET archived = ? WHERE id = ?`).run(patch.archived, threadId);
    }
  } finally {
    db.close();
  }
}

function insertStateThread(input: {
  dbPath: string;
  threadId: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  updatedAt: number;
  createdAt?: number;
  provider?: string;
  source?: string;
  gitBranch?: string;
  gitOriginUrl?: string;
  firstUserMessage?: string;
}) {
  const db = new Database(input.dbPath);
  try {
    db.query(`
      INSERT INTO threads (
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        archived,
        cli_version,
        first_user_message,
        git_branch,
        git_origin_url,
        model,
        reasoning_effort
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.threadId,
      input.rolloutPath,
      input.createdAt ?? input.updatedAt,
      input.updatedAt,
      input.source ?? "cli",
      input.provider ?? "Spencer",
      input.cwd,
      input.title,
      "workspace-write",
      "on-request",
      0,
      0,
      "0.119.0",
      input.firstUserMessage ?? "",
      input.gitBranch ?? "",
      input.gitOriginUrl ?? "",
      "gpt-5.4",
      "high",
    );
  } finally {
    db.close();
  }
}

function readIndexedThread(indexDb: string, threadId: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    return db
      .query(
        `SELECT thread_id, title, message_count, file_exists, source_file, updated_at, archived FROM threads WHERE thread_id = ?`,
      )
      .get(threadId) as
      | {
          thread_id: string;
          title: string;
          message_count: number;
          file_exists: number;
          source_file: string;
          updated_at: number;
          archived: number;
        }
      | null;
  } finally {
    db.close();
  }
}

function readThreadCount(indexDb: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM threads`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readFtsRowCount(indexDb: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM messages_fts`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readThreadSourceCount(indexDb: string, threadId: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM thread_sources WHERE thread_id = ?`).get(threadId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readMetaValue(indexDb: string, key: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    const row = db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function readSyncMetaValue(indexDb: string, key: string) {
  const db = new Database(indexDb, { readonly: true });
  try {
    const row = db.query(`SELECT value FROM sync_meta WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

test("inspect source reports offline local state without auth", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const result = runCli(["--json", "inspect", "source"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as { ok: true; data: Record<string, unknown> };
  expect(payload.ok).toBe(true);
  expect(payload.data.authRequired).toBe(false);
  expect(payload.data.stateDbExists).toBe(true);
  expect(payload.data.sessionFileCount).toBe(1);
});

test("inspect paths groups observed cwd values and derives repo/worktree scopes", () => {
  const repoRoot = "/tmp/scoped-project";
  const worktreeRoot = "/tmp/scoped-project.worktrees/feat-a";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T05:00:00.000Z", role: "user", text: "alpha" }],
      }),
    },
    {
      fileName: "rollout-main-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-subdir",
        title: "Main subdir",
        cwd: `${repoRoot}/packages/app`,
        messages: [{ timestamp: "2026-04-11T04:00:00.000Z", role: "user", text: "beta" }],
      }),
    },
    {
      fileName: "rollout-worktree-root-1.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root-1",
        title: "Worktree root 1",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "gamma" }],
      }),
    },
    {
      fileName: "rollout-worktree-root-2.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root-2",
        title: "Worktree root 2",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "delta" }],
      }),
    },
    {
      fileName: "rollout-worktree-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-subdir",
        title: "Worktree subdir",
        cwd: `${worktreeRoot}/apps/web`,
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "epsilon" }],
      }),
    },
    {
      fileName: "rollout-other.jsonl",
      contents: makeSessionJsonl({
        threadId: "other-project",
        title: "Other project",
        cwd: "/tmp/other-project",
        messages: [{ timestamp: "2026-04-11T00:00:00.000Z", role: "user", text: "zeta" }],
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-root.jsonl"),
    cwd: repoRoot,
    title: "Main root",
    updatedAt: 1_744_350_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-subdir.jsonl"),
    cwd: `${repoRoot}/packages/app`,
    title: "Main subdir",
    updatedAt: 1_744_349_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-root-1",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-root-1.jsonl"),
    cwd: worktreeRoot,
    title: "Worktree root 1",
    updatedAt: 1_744_348_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-root-2",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-root-2.jsonl"),
    cwd: worktreeRoot,
    title: "Worktree root 2",
    updatedAt: 1_744_347_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-subdir.jsonl"),
    cwd: `${worktreeRoot}/apps/web`,
    title: "Worktree subdir",
    updatedAt: 1_744_346_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "other-project",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-other.jsonl"),
    cwd: "/tmp/other-project",
    title: "Other project",
    updatedAt: 1_744_345_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/other-project.git",
  });

  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const result = runCli(["--json", "--refresh", "inspect", "paths", "--limit", "10"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: {
      subject: string;
      results: Array<Record<string, unknown>>;
    };
  };
  expect(payload.data.subject).toBe("paths");

  const byCwd = new Map(payload.data.results.map((row) => [String(row.cwd), row]));
  expect(byCwd.get(repoRoot)?.path_kind).toBe("repo");
  expect(byCwd.get(repoRoot)?.live_status).toBe("missing");
  expect(byCwd.get(repoRoot)?.repo_scope).toBe(repoRoot);
  expect((byCwd.get(repoRoot)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--repo");

  expect(byCwd.get(`${repoRoot}/packages/app`)?.path_kind).toBe("cwd");
  expect(byCwd.get(`${repoRoot}/packages/app`)?.live_status).toBe("missing");
  expect(byCwd.get(`${repoRoot}/packages/app`)?.repo_scope).toBe(repoRoot);
  expect((byCwd.get(`${repoRoot}/packages/app`)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--repo");

  expect(byCwd.get(worktreeRoot)?.path_kind).toBe("worktree");
  expect(byCwd.get(worktreeRoot)?.live_status).toBe("missing");
  expect(byCwd.get(worktreeRoot)?.repo_scope).toBe(repoRoot);
  expect(byCwd.get(worktreeRoot)?.worktree_scope).toBe(worktreeRoot);
  expect(byCwd.get(worktreeRoot)?.thread_count).toBe(2);
  expect((byCwd.get(worktreeRoot)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--worktree");

  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.path_kind).toBe("worktree");
  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.live_status).toBe("missing");
  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.worktree_scope).toBe(worktreeRoot);

  expect(byCwd.get("/tmp/other-project")?.path_kind).toBe("cwd");
  expect(byCwd.get("/tmp/other-project")?.live_status).toBe("missing");
  expect((byCwd.get("/tmp/other-project")?.recommended_scope as Record<string, unknown>)?.flag).toBe("--cwd");
});

test("inspect paths verifies live git repo and worktree scopes when paths exist", () => {
  const { repoRoot, worktreeRoot } = makeLiveGitRepoFixture();
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T05:00:00.000Z", role: "user", text: "alpha" }],
      }),
    },
    {
      fileName: "rollout-main-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-subdir",
        title: "Main subdir",
        cwd: `${repoRoot}/packages/app`,
        messages: [{ timestamp: "2026-04-11T04:00:00.000Z", role: "user", text: "beta" }],
      }),
    },
    {
      fileName: "rollout-worktree-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root",
        title: "Worktree root",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "gamma" }],
      }),
    },
    {
      fileName: "rollout-worktree-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-subdir",
        title: "Worktree subdir",
        cwd: `${worktreeRoot}/apps/web`,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "delta" }],
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-root.jsonl"),
    cwd: repoRoot,
    title: "Main root",
    updatedAt: 1_744_350_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-subdir.jsonl"),
    cwd: `${repoRoot}/packages/app`,
    title: "Main subdir",
    updatedAt: 1_744_349_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-root.jsonl"),
    cwd: worktreeRoot,
    title: "Worktree root",
    updatedAt: 1_744_348_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-subdir.jsonl"),
    cwd: `${worktreeRoot}/apps/web`,
    title: "Worktree subdir",
    updatedAt: 1_744_347_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });

  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const result = runCli(["--json", "--refresh", "inspect", "paths", "--limit", "10"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };

  const byCwd = new Map(payload.data.results.map((row) => [String(row.cwd), row]));
  expect(byCwd.get(repoRoot)?.live_status).toBe("verified");
  expect(byCwd.get(repoRoot)?.path_kind).toBe("repo");
  expect(byCwd.get(repoRoot)?.live_repo_scope).toBe(repoRoot);
  expect(byCwd.get(repoRoot)?.live_worktree_scope).toBe(repoRoot);
  expect((byCwd.get(repoRoot)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--repo");

  expect(byCwd.get(`${repoRoot}/packages/app`)?.live_status).toBe("verified");
  expect(byCwd.get(`${repoRoot}/packages/app`)?.path_kind).toBe("cwd");
  expect(byCwd.get(`${repoRoot}/packages/app`)?.repo_scope).toBe(repoRoot);
  expect((byCwd.get(`${repoRoot}/packages/app`)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--repo");

  expect(byCwd.get(worktreeRoot)?.live_status).toBe("verified");
  expect(byCwd.get(worktreeRoot)?.path_kind).toBe("worktree");
  expect(byCwd.get(worktreeRoot)?.live_repo_scope).toBe(repoRoot);
  expect(byCwd.get(worktreeRoot)?.live_worktree_scope).toBe(worktreeRoot);
  expect((byCwd.get(worktreeRoot)?.recommended_scope as Record<string, unknown>)?.flag).toBe("--worktree");

  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.live_status).toBe("verified");
  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.path_kind).toBe("worktree");
  expect(byCwd.get(`${worktreeRoot}/apps/web`)?.worktree_scope).toBe(worktreeRoot);
});

test("inspect paths supports match filtering and compact human output", () => {
  const worktreeRoot = "/tmp/scoped-project.worktrees/feat-a";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-worktree.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root",
        title: "Worktree root",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "needle" }],
      }),
    },
    {
      fileName: "rollout-other.jsonl",
      contents: makeSessionJsonl({
        threadId: "other-project",
        title: "Other project",
        cwd: "/tmp/other-project",
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "needle" }],
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree.jsonl"),
    cwd: worktreeRoot,
    title: "Worktree root",
    updatedAt: 1_744_348_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "other-project",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-other.jsonl"),
    cwd: "/tmp/other-project",
    title: "Other project",
    updatedAt: 1_744_345_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/other-project.git",
  });

  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const jsonResult = runCli(
    ["--json", "--refresh", "inspect", "paths", "--match", "scoped-project.git", "--limit", "10"],
    sourceRoot,
    indexDb,
  );

  expect(jsonResult.status).toBe(0);
  const jsonPayload = JSON.parse(jsonResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(jsonPayload.data.results).toHaveLength(1);
  expect(jsonPayload.data.results[0]?.cwd).toBe(worktreeRoot);

  const humanResult = runCli(
    ["--refresh", "inspect", "paths", "--match", "feat-a", "--limit", "10"],
    sourceRoot,
    indexDb,
  );
  expect(humanResult.status).toBe(0);
  expect(humanResult.stdout).toContain(`[worktree] ${worktreeRoot}`);
  expect(humanResult.stdout).toContain(`scope: --worktree ${worktreeRoot}`);
});

test("inspect paths supports cwd, repo, and worktree scope filters", () => {
  const repoRoot = "/tmp/scoped-project";
  const worktreeRoot = "/tmp/scoped-project.worktrees/feat-a";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T05:00:00.000Z", role: "user", text: "alpha" }],
      }),
    },
    {
      fileName: "rollout-main-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-subdir",
        title: "Main subdir",
        cwd: `${repoRoot}/packages/app`,
        messages: [{ timestamp: "2026-04-11T04:00:00.000Z", role: "user", text: "beta" }],
      }),
    },
    {
      fileName: "rollout-worktree-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root",
        title: "Worktree root",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "gamma" }],
      }),
    },
    {
      fileName: "rollout-worktree-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-subdir",
        title: "Worktree subdir",
        cwd: `${worktreeRoot}/apps/web`,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "delta" }],
      }),
    },
    {
      fileName: "rollout-other.jsonl",
      contents: makeSessionJsonl({
        threadId: "other-project",
        title: "Other project",
        cwd: "/tmp/other-project",
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "epsilon" }],
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-root.jsonl"),
    cwd: repoRoot,
    title: "Main root",
    updatedAt: 1_744_350_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "main-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-main-subdir.jsonl"),
    cwd: `${repoRoot}/packages/app`,
    title: "Main subdir",
    updatedAt: 1_744_349_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-root",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-root.jsonl"),
    cwd: worktreeRoot,
    title: "Worktree root",
    updatedAt: 1_744_348_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "worktree-subdir",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-worktree-subdir.jsonl"),
    cwd: `${worktreeRoot}/apps/web`,
    title: "Worktree subdir",
    updatedAt: 1_744_347_000_000,
    gitBranch: "feat-a",
    gitOriginUrl: "https://example.com/scoped-project.git",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "other-project",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-other.jsonl"),
    cwd: "/tmp/other-project",
    title: "Other project",
    updatedAt: 1_744_346_000_000,
    gitBranch: "main",
    gitOriginUrl: "https://example.com/other-project.git",
  });

  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const repoResult = runCli(["--json", "--refresh", "inspect", "paths", "--repo", repoRoot, "--limit", "10"], sourceRoot, indexDb);
  expect(repoResult.status).toBe(0);
  const repoPayload = JSON.parse(repoResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(repoPayload.data.results.map((row) => row.cwd)).toEqual([
    repoRoot,
    `${repoRoot}/packages/app`,
    worktreeRoot,
    `${worktreeRoot}/apps/web`,
  ]);

  const worktreeResult = runCli(
    ["--json", "inspect", "paths", "--worktree", worktreeRoot, "--limit", "10"],
    sourceRoot,
    indexDb,
  );
  expect(worktreeResult.status).toBe(0);
  const worktreePayload = JSON.parse(worktreeResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(worktreePayload.data.results.map((row) => row.cwd)).toEqual([worktreeRoot, `${worktreeRoot}/apps/web`]);

  const cwdResult = runCli(
    ["--json", "inspect", "paths", "--cwd", `${repoRoot}/packages/app`, "--limit", "10"],
    sourceRoot,
    indexDb,
  );
  expect(cwdResult.status).toBe(0);
  const cwdPayload = JSON.parse(cwdResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(cwdPayload.data.results.map((row) => row.cwd)).toEqual([`${repoRoot}/packages/app`]);
});

test("inspect paths marks existing non-git directories as not_git", () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), "agent-threads-non-git-"));
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-non-git.jsonl",
      contents: makeSessionJsonl({
        threadId: "non-git",
        title: "Non git path",
        cwd: nonGitDir,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "needle" }],
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  insertStateThread({
    dbPath: stateDb,
    threadId: "non-git",
    rolloutPath: join(sourceRoot, "sessions", "2026", "04", "11", "rollout-non-git.jsonl"),
    cwd: nonGitDir,
    title: "Non git path",
    updatedAt: 1_744_348_000_000,
    gitOriginUrl: "https://example.com/non-git.git",
  });

  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const result = runCli(["--json", "--refresh", "inspect", "paths", "--limit", "10"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.cwd).toBe(nonGitDir);
  expect(payload.data.results[0]?.path_exists).toBe(true);
  expect(payload.data.results[0]?.live_status).toBe("not_git");
  expect((payload.data.results[0]?.recommended_scope as Record<string, unknown>)?.flag).toBe("--cwd");
});

test("find and open work against rebuilt local index", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const searchResult = runCli(
    ["--json", "--refresh", "find", "notify_url", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(searchResult.status).toBe(0);
  const searchPayload = JSON.parse(searchResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(searchPayload.ok).toBe(true);
  expect(searchPayload.data.results[0]?.thread_id).toBe("thread-epay-fix");

  const contextResult = runCli(
    ["--json", "open", "thread-epay-fix:2", "--before", "1", "--after", "1"],
    sourceRoot,
    indexDb,
  );
  expect(contextResult.status).toBe(0);
  const contextPayload = JSON.parse(contextResult.stdout) as {
    ok: true;
    data: { anchor: Record<string, unknown>; messages: Array<Record<string, unknown>> };
  };
  expect(contextPayload.data.anchor.seq).toBe(2);
  expect(contextPayload.data.messages.length).toBe(3);
});

test("incremental sync leaves unchanged indexes as a no-op when the source fingerprint is unchanged", () => {
  const sourceRoot = makeTrustedManifestSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "find", "notify_url"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const builtAtBefore = readMetaValue(indexDb, "built_at");
  const lastSyncAtBefore = readSyncMetaValue(indexDb, "last_sync_at");
  const sourceFingerprintBefore = readSyncMetaValue(indexDb, "last_source_fingerprint");
  const threadBefore = readIndexedThread(indexDb, "thread-epay-fix");

  const second = runCli(["--json", "find", "notify_url"], sourceRoot, indexDb);
  expect(second.status).toBe(0);

  const builtAtAfter = readMetaValue(indexDb, "built_at");
  const lastSyncAtAfter = readSyncMetaValue(indexDb, "last_sync_at");
  const sourceFingerprintAfter = readSyncMetaValue(indexDb, "last_source_fingerprint");
  const threadAfter = readIndexedThread(indexDb, "thread-epay-fix");

  expect(builtAtAfter).toBe(builtAtBefore);
  expect(lastSyncAtAfter).toBe(lastSyncAtBefore);
  expect(sourceFingerprintAfter).toBe(sourceFingerprintBefore);
  expect(threadAfter?.message_count).toBe(threadBefore?.message_count);
  expect(threadAfter?.updated_at).toBe(threadBefore?.updated_at);
});

test("incremental sync indexes a newly added session file without rebuilding other threads", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);
  const original = readIndexedThread(indexDb, "thread-epay-fix");

  const newSessionPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-thread-new.jsonl");
  writeFileSync(
    newSessionPath,
    makeSessionJsonl({
      threadId: "thread-new",
      title: "Thread new",
      messages: [
        {
          timestamp: "2026-04-11T05:00:00.000Z",
          role: "user",
          text: "new thread question",
        },
        {
          timestamp: "2026-04-11T05:00:15.000Z",
          role: "assistant",
          text: "new thread answer",
        },
      ],
    }),
    "utf8",
  );
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    },
    {
      id: "thread-new",
      thread_name: "Thread new",
      updated_at: "2026-04-11T05:00:15.000Z",
    },
  ]);

  const result = runCli(["--json", "recent", "--limit", "10"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  expect(readThreadCount(indexDb)).toBe(2);
  expect(readIndexedThread(indexDb, "thread-new")?.message_count).toBe(2);
  expect(readIndexedThread(indexDb, "thread-epay-fix")?.message_count).toBe(original?.message_count);
});

test("fresh recent builds keep zero-message threads consistent with explicit reindex", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-thread-a.jsonl",
      contents: makeSessionJsonl({
        threadId: "thread-a",
        title: "Thread A",
        cwd: "/tmp/thread-a",
        messages: [
          {
            timestamp: "2026-04-11T03:00:00.000Z",
            role: "user",
            text: "alpha question",
          },
          {
            timestamp: "2026-04-11T03:00:15.000Z",
            role: "assistant",
            text: "alpha answer",
          },
        ],
      }),
    },
    {
      fileName: "rollout-thread-empty-1.jsonl",
      contents: makeSessionMetaOnlyJsonl({
        threadId: "thread-empty-1",
        title: "Thread empty 1",
        cwd: "/tmp/thread-empty-1",
      }),
    },
    {
      fileName: "rollout-thread-empty-2.jsonl",
      contents: makeSessionMetaOnlyJsonl({
        threadId: "thread-empty-2",
        title: "Thread empty 2",
        cwd: "/tmp/thread-empty-2",
      }),
    },
  ]);
  const stateDb = join(sourceRoot, "state_5.sqlite");
  const sessionsDir = join(sourceRoot, "sessions", "2026", "04", "11");
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  insertStateThread({
    dbPath: stateDb,
    threadId: "thread-a",
    rolloutPath: join(sessionsDir, "rollout-thread-a.jsonl"),
    cwd: "/tmp/thread-a",
    title: "Thread A",
    updatedAt: Date.parse("2026-04-11T03:00:15.000Z"),
    firstUserMessage: "alpha question",
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "thread-empty-1",
    rolloutPath: join(sessionsDir, "rollout-thread-empty-1.jsonl"),
    cwd: "/tmp/thread-empty-1",
    title: "Thread empty 1",
    updatedAt: Date.parse("2026-04-11T03:10:00.000Z"),
  });
  insertStateThread({
    dbPath: stateDb,
    threadId: "thread-empty-2",
    rolloutPath: join(sessionsDir, "rollout-thread-empty-2.jsonl"),
    cwd: "/tmp/thread-empty-2",
    title: "Thread empty 2",
    updatedAt: Date.parse("2026-04-11T03:20:00.000Z"),
  });

  const recent = runCli(["--json", "recent", "--limit", "10"], sourceRoot, indexDb);
  expect(recent.status).toBe(0);

  const statsBeforeResult = runCli(
    [
      "--json",
      "admin",
      "sql",
      "select count(*) as thread_count, coalesce(sum(message_count), 0) as message_count, sum(case when message_count = 0 then 1 else 0 end) as zero_message_threads from threads",
    ],
    sourceRoot,
    indexDb,
  );
  expect(statsBeforeResult.status).toBe(0);
  const statsBeforePayload = JSON.parse(statsBeforeResult.stdout) as {
    ok: true;
    data: Array<{ thread_count: number; message_count: number; zero_message_threads: number }>;
  };
  const statsBefore = statsBeforePayload.data[0];

  const inspect = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(inspect.status).toBe(0);
  const inspectPayload = JSON.parse(inspect.stdout) as {
    ok: true;
    data: { thread_count: number; message_count: number };
  };

  expect(readThreadCount(indexDb)).toBe(3);
  expect(readIndexedThread(indexDb, "thread-empty-1")?.message_count).toBe(0);
  expect(readIndexedThread(indexDb, "thread-empty-2")?.message_count).toBe(0);
  expect(statsBefore).toEqual({
    thread_count: 3,
    message_count: 2,
    zero_message_threads: 2,
  });
  expect(inspectPayload.data.thread_count).toBe(statsBefore.thread_count);
  expect(inspectPayload.data.message_count).toBe(statsBefore.message_count);

  const reindex = runCli(["--json", "admin", "reindex"], sourceRoot, indexDb);
  expect(reindex.status).toBe(0);
  const reindexPayload = JSON.parse(reindex.stdout) as {
    ok: true;
    data: { threadCount: number; messageCount: number };
  };

  const statsAfterResult = runCli(
    [
      "--json",
      "admin",
      "sql",
      "select count(*) as thread_count, coalesce(sum(message_count), 0) as message_count, sum(case when message_count = 0 then 1 else 0 end) as zero_message_threads from threads",
    ],
    sourceRoot,
    indexDb,
  );
  expect(statsAfterResult.status).toBe(0);
  const statsAfterPayload = JSON.parse(statsAfterResult.stdout) as {
    ok: true;
    data: Array<{ thread_count: number; message_count: number; zero_message_threads: number }>;
  };

  expect(reindexPayload.data.threadCount).toBe(statsBefore.thread_count);
  expect(reindexPayload.data.messageCount).toBe(statsBefore.message_count);
  expect(statsAfterPayload.data[0]).toEqual(statsBefore);
  expect(readIndexedThread(indexDb, "thread-empty-1")?.message_count).toBe(0);
  expect(readIndexedThread(indexDb, "thread-empty-2")?.message_count).toBe(0);
});

test("incremental sync rebuilds only the changed thread", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-thread-a.jsonl",
      contents: makeSessionJsonl({
        threadId: "thread-a",
        title: "Thread A",
        messages: [
          {
            timestamp: "2026-04-11T03:00:00.000Z",
            role: "user",
            text: "alpha needle",
          },
          {
            timestamp: "2026-04-11T03:00:15.000Z",
            role: "assistant",
            text: "alpha answer",
          },
        ],
      }),
    },
    {
      fileName: "rollout-thread-b.jsonl",
      contents: makeSessionJsonl({
        threadId: "thread-b",
        title: "Thread B",
        messages: [
          {
            timestamp: "2026-04-11T04:00:00.000Z",
            role: "user",
            text: "beta needle",
          },
          {
            timestamp: "2026-04-11T04:00:15.000Z",
            role: "assistant",
            text: "beta answer",
          },
        ],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const beforeA = readIndexedThread(indexDb, "thread-a");
  const beforeB = readIndexedThread(indexDb, "thread-b");
  const sessionAPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-thread-a.jsonl");

  writeFileSync(
    sessionAPath,
    makeSessionJsonl({
      threadId: "thread-a",
      title: "Thread A",
      messages: [
        {
          timestamp: "2026-04-11T03:00:00.000Z",
          role: "user",
          text: "alpha needle",
        },
        {
          timestamp: "2026-04-11T03:00:15.000Z",
          role: "assistant",
          text: "alpha answer",
        },
        {
          timestamp: "2026-04-11T03:01:00.000Z",
          role: "assistant",
          text: "alpha follow-up",
        },
      ],
    }),
    "utf8",
  );

  const result = runCli(["--json", "find", "alpha"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  expect(readIndexedThread(indexDb, "thread-a")?.message_count).toBe((beforeA?.message_count ?? 0) + 1);
  expect(readIndexedThread(indexDb, "thread-b")?.message_count).toBe(beforeB?.message_count);
});

test("incremental sync preserves sibling session files for one thread", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-continued-1.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "continued",
            cwd: "/tmp/continued",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Continued thread",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:30.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "initial question" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:31.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "initial answer" },
        }),
        "",
      ].join("\n"),
    },
    {
      fileName: "rollout-continued-2.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "continued",
            cwd: "/tmp/continued",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Continued thread",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:40.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "follow up question" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:41.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "follow up answer" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:42.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "final question" },
        }),
        "",
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const secondPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-continued-2.jsonl");
  writeFileSync(
    secondPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "continued",
          cwd: "/tmp/continued",
          source: "cli",
          model_provider: "Spencer",
          thread_name: "Continued thread",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:43:40.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "follow up question" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:43:41.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "follow up answer" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:43:42.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "final question" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:43:43.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "final answer" },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runCli(["--json", "open", "continued", "--format", "messages", "--full"], sourceRoot, indexDb);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { messages: Array<Record<string, unknown>> };
  };
  expect(payload.data.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("state metadata changes refresh thread metadata without rebuilding messages", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const before = readIndexedThread(indexDb, "thread-epay-fix");
  const lastSyncAtBefore = readSyncMetaValue(indexDb, "last_sync_at");
  updateStateThread(join(sourceRoot, "state_5.sqlite"), "thread-epay-fix", {
    title: "Clean metadata title",
    updatedAt: 1_744_338_999_000,
  });

  const result = runCli(["--json", "recent", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  const after = readIndexedThread(indexDb, "thread-epay-fix");
  const lastSyncAtAfter = readSyncMetaValue(indexDb, "last_sync_at");
  expect(after?.title).toBe("Clean metadata title");
  expect(after?.message_count).toBe(before?.message_count);
  expect(after?.updated_at).toBe(1_744_338_999_000);
  expect(lastSyncAtAfter).not.toBe(lastSyncAtBefore);
});

test("metadata-only sync respects archived changes from the state database", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  updateStateThread(join(sourceRoot, "state_5.sqlite"), "thread-epay-fix", {
    updatedAt: 1_744_339_000_000,
    archived: 1,
  });

  const result = runCli(["--json", "recent", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  expect(readIndexedThread(indexDb, "thread-epay-fix")?.archived).toBe(1);
});

test("unstable trailing JSON does not roll back an indexed thread", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const before = readIndexedThread(indexDb, "thread-epay-fix");
  writeFileSync(
    getDefaultSessionPath(sourceRoot),
    `${fixtureSession}\n{"timestamp":"2026-04-11T05:20:00.000Z","type":"event_msg","payload":{"type":"assistant_message","message":"partial"`,
    "utf8",
  );
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T05:20:00.000Z",
    },
  ]);

  const result = runCli(["--json", "recent", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  const after = readIndexedThread(indexDb, "thread-epay-fix");
  expect(after?.message_count).toBe(before?.message_count);
  expect(after?.source_file).toBe(before?.source_file);
});

test("missing files are marked before they are deleted", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-thread-missing.jsonl",
    makeSessionJsonl({
      threadId: "thread-missing",
      title: "Thread Missing",
      messages: [
        {
          timestamp: "2026-04-11T06:00:00.000Z",
          role: "user",
          text: "where did the file go",
        },
      ],
    }),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const sessionPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-thread-missing.jsonl");
  unlinkSync(sessionPath);

  const firstPass = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(firstPass.status).toBe(0);
  expect(readThreadCount(indexDb)).toBe(1);
  expect(readIndexedThread(indexDb, "thread-missing")?.file_exists).toBe(0);

  const secondPass = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(secondPass.status).toBe(0);
  expect(readThreadCount(indexDb)).toBe(0);
}, 10_000);

test("find returns a compact unified result shape", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "notify_url", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data.results[0]?.target).toBeDefined();
  expect(payload.data.results[0]?.snippet).toBeDefined();
  expect(payload.data.results[0]?.source_file).toBeUndefined();
});

test("find --kind message returns snippets instead of full text", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.kind).toBe("message");
  expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data.results[0]?.snippet).toBeDefined();
  expect(payload.data.results[0]?.text).toBeUndefined();
});

test("rebuild creates a message-search FTS index with one row per indexed message", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { message_count: number };
  };
  expect(readFtsRowCount(indexDb)).toBe(payload.data.message_count);
});

test("find --kind message falls back when words FTS cannot express a substring query", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-short-query.jsonl",
    makeSessionJsonl({
      threadId: "short-query",
      title: "Short query thread",
      messages: [
        {
          timestamp: "2026-04-11T02:43:30.000Z",
          role: "user",
          text: "payment_callback_url retry issue",
        },
      ],
    }),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "callback_u", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("short-query");
});

test("message search supports code-ish tokens with punctuation", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-tokenchars.jsonl",
    makeSessionJsonl({
      threadId: "tokenchars",
      title: "Tokenchars thread",
      messages: [
        {
          timestamp: "2026-04-11T02:43:30.000Z",
          role: "assistant",
          text: "Use epay:notify and /payments/callback before shipping notify_url.",
        },
      ],
    }),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const notifyResult = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(notifyResult.status).toBe(0);
  const notifyPayload = JSON.parse(notifyResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(notifyPayload.data.results[0]?.thread_id).toBe("tokenchars");

  const punctuatedResult = runCli(
    ["--json", "find", "epay:notify", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(punctuatedResult.status).toBe(0);
  const punctuatedPayload = JSON.parse(punctuatedResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(punctuatedPayload.data.results[0]?.thread_id).toBe("tokenchars");
});

test("find --kind message keeps only the strongest hit per thread", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-dedupe-a.jsonl",
      contents: makeSessionJsonl({
        threadId: "dedupe-a",
        title: "Dedupe thread A",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "assistant", text: "needle alpha" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "needle beta" },
        ],
      }),
    },
    {
      fileName: "rollout-dedupe-b.jsonl",
      contents: makeSessionJsonl({
        threadId: "dedupe-b",
        title: "Dedupe thread B",
        messages: [{ timestamp: "2026-04-11T02:43:32.000Z", role: "assistant", text: "needle gamma" }],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "find", "needle", "--kind", "message", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results.map((row) => row.thread_id)).toEqual(["dedupe-b", "dedupe-a"]);
});

test("find --kind message boosts title and first-user-message matches ahead of plain message hits", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-rank-title.jsonl",
      contents: makeSessionJsonl({
        threadId: "rank-title",
        title: "Payment callback fix",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "user", text: "unrelated setup" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "payment token" },
        ],
      }),
    },
    {
      fileName: "rollout-rank-first-user.jsonl",
      contents: makeSessionJsonl({
        threadId: "rank-first-user",
        title: "Other thread",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "user", text: "Need payment flow help" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "payment token" },
        ],
      }),
    },
    {
      fileName: "rollout-rank-plain.jsonl",
      contents: makeSessionJsonl({
        threadId: "rank-plain",
        title: "Other thread",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "user", text: "unrelated setup" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "payment token" },
        ],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "find", "payment", "--kind", "message", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results.map((row) => row.thread_id)).toEqual([
    "rank-title",
    "rank-first-user",
    "rank-plain",
  ]);
  expect(payload.data.results[0]?.why_matched).toEqual(["message", "title"]);
  expect(payload.data.results[1]?.why_matched).toEqual(["message", "first_user_message"]);
});

test("find --kind message downranks meta discussion for broad natural-language queries", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-real-error.jsonl",
      contents: makeSessionJsonl({
        threadId: "real-error",
        title: "Payment callback issue",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "user", text: "Need better error handling for callback retries" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "We should improve error handling in the payment callback path." },
        ],
      }),
    },
    {
      fileName: "rollout-meta-error.jsonl",
      contents: makeSessionJsonl({
        threadId: "meta-error",
        title:
          "You are reviewing a planned change. Return concise review with error handling notes.",
        messages: [
          { timestamp: "2026-04-11T02:43:40.000Z", role: "user", text: "Ground your review and discuss error handling strategy." },
          { timestamp: "2026-04-11T02:43:41.000Z", role: "assistant", text: "No code changes. Review the error handling approach only." },
        ],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "find", "error handling", "--kind", "message", "--limit", "5"], sourceRoot, indexDb);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.thread_id).toBe("real-error");
  expect(payload.data.results[1]?.thread_id).toBe("meta-error");
});

test("incremental sync refreshes message FTS hits without leaving stale matches", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const sessionPath = getDefaultSessionPath(sourceRoot);

  const initial = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(initial.status).toBe(0);

  writeFileSync(sessionPath, `${fixtureSession.replaceAll("notify_url", "callback_url")}\n`, "utf8");
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:44:00.000Z",
    },
  ]);

  const updated = runCli(
    ["--json", "find", "callback_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(updated.status).toBe(0);
  const updatedPayload = JSON.parse(updated.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(updatedPayload.data.results[0]?.thread_id).toBe("thread-epay-fix");

  const stale = runCli(
    ["--json", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(stale.status).toBe(0);
  const stalePayload = JSON.parse(stale.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(stalePayload.data.results).toHaveLength(0);
});

test("live session shard changes still invalidate warm reads even when the source fingerprint metadata is unchanged", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const sessionPath = getDefaultSessionPath(sourceRoot);

  const initial = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(initial.status).toBe(0);

  writeFileSync(sessionPath, `${fixtureSession.replaceAll("notify_url", "callback_url")}\n`, "utf8");

  const updated = runCli(
    ["--json", "find", "callback_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(updated.status).toBe(0);
  const updatedPayload = JSON.parse(updated.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(updatedPayload.data.results[0]?.thread_id).toBe("thread-epay-fix");
});

test("session index fingerprint changes invalidate the warm-read fast path", () => {
  const sourceRoot = makeTrustedManifestSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const sourceFingerprintBefore = readSyncMetaValue(indexDb, "last_source_fingerprint");
  const before = readIndexedThread(indexDb, "thread-epay-fix");
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:45:00.000Z",
    },
    {
      id: "thread-shadow",
      thread_name: "Shadow thread",
      updated_at: "2026-04-11T02:45:01.000Z",
    },
  ]);

  const result = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(result.status).toBe(0);

  const sourceFingerprintAfter = readSyncMetaValue(indexDb, "last_source_fingerprint");
  expect(sourceFingerprintAfter).not.toBe(sourceFingerprintBefore);
  expect(readIndexedThread(indexDb, "thread-epay-fix")?.message_count).toBe(before?.message_count);
});

test("trusted manifest fast path tolerates unrelated log growth for unchanged tracked files", () => {
  const sourceRoot = makeTrustedManifestSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const lastSyncAtBefore = readSyncMetaValue(indexDb, "last_sync_at");
  appendLogRow(join(sourceRoot, "logs_2.sqlite"), "thread-epay-fix");

  const second = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(second.status).toBe(0);

  const lastSyncAtAfter = readSyncMetaValue(indexDb, "last_sync_at");
  expect(lastSyncAtAfter).toBe(lastSyncAtBefore);
});

test("trusted manifest selective sync refreshes active thread hits without a full source fingerprint change", () => {
  const sourceRoot = makeTrustedManifestSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const sessionPath = getDefaultSessionPath(sourceRoot);

  const initial = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(initial.status).toBe(0);

  writeFileSync(sessionPath, `${fixtureSession.replaceAll("notify_url", "callback_url")}\n`, "utf8");
  appendLogRow(join(sourceRoot, "logs_2.sqlite"), "thread-epay-fix");

  const updated = runCli(
    ["--json", "find", "callback_url", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(updated.status).toBe(0);
  const updatedPayload = JSON.parse(updated.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(updatedPayload.data.results[0]?.thread_id).toBe("thread-epay-fix");
});

test("stale sibling tracked source rows are cleaned even when no other writes are pending", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-continued-1.jsonl",
      contents: makeSessionJsonl({
        threadId: "continued",
        title: "Continued thread",
        messages: [
          { timestamp: "2026-04-11T02:43:30.000Z", role: "user", text: "initial question" },
          { timestamp: "2026-04-11T02:43:31.000Z", role: "assistant", text: "initial answer" },
        ],
      }),
    },
    {
      fileName: "rollout-continued-2.jsonl",
      contents: makeSessionJsonl({
        threadId: "continued",
        title: "Continued thread",
        messages: [
          { timestamp: "2026-04-11T02:43:40.000Z", role: "user", text: "follow up question" },
          { timestamp: "2026-04-11T02:43:41.000Z", role: "assistant", text: "follow up answer" },
        ],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);
  expect(readThreadSourceCount(indexDb, "continued")).toBe(2);

  const secondShardPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-continued-2.jsonl");
  unlinkSync(secondShardPath);

  const refreshed = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(refreshed.status).toBe(0);
  expect(readThreadSourceCount(indexDb, "continued")).toBe(1);
});

test("find --kind message applies provider filtering before the limit", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-other-1.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "other-1",
            cwd: "/tmp/shared-project",
            source: "cli",
            model_provider: "Other",
            thread_name: "Other thread 1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "needle message",
          },
        }),
      ].join("\n"),
    },
    {
      fileName: "rollout-other-2.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "other-2",
            cwd: "/tmp/shared-project",
            source: "cli",
            model_provider: "Other",
            thread_name: "Other thread 2",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "needle message",
          },
        }),
      ].join("\n"),
    },
    {
      fileName: "rollout-other-3.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "other-3",
            cwd: "/tmp/shared-project",
            source: "cli",
            model_provider: "Other",
            thread_name: "Other thread 3",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T01:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "needle message",
          },
        }),
      ].join("\n"),
    },
    {
      fileName: "rollout-target.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "target-thread",
            cwd: "/tmp/shared-project",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Target thread",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T00:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "needle message",
          },
        }),
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "needle", "--kind", "message", "--provider", "Spencer", "--limit", "1"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("target-thread");
  expect(payload.data.results[0]?.provider).toBe("Spencer");
});

test("find --kind thread supports repo-scoped filtering across repo and worktrees", () => {
  const repoRoot = "/tmp/scoped-project";
  const worktreeRoot = "/tmp/scoped-project.worktrees/feat-a";
  const siblingWorktreeRoot = "/tmp/scoped-project.worktrees/fix-b";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Needle main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T05:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-main-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-subdir",
        title: "Needle main subdir",
        cwd: `${repoRoot}/packages/app`,
        messages: [{ timestamp: "2026-04-11T04:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-worktree.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root",
        title: "Needle worktree root",
        cwd: worktreeRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-worktree-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-subdir",
        title: "Needle worktree subdir",
        cwd: `${worktreeRoot}/apps/web`,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-sibling-worktree.jsonl",
      contents: makeSessionJsonl({
        threadId: "sibling-worktree",
        title: "Needle sibling worktree",
        cwd: siblingWorktreeRoot,
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-other.jsonl",
      contents: makeSessionJsonl({
        threadId: "other-project",
        title: "Needle other project",
        cwd: "/tmp/other-project",
        messages: [{ timestamp: "2026-04-11T00:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "needle", "--kind", "thread", "--repo", repoRoot, "--limit", "10"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<{ thread_id: string }> };
  };
  expect(payload.data.results.map((row) => row.thread_id).sort()).toEqual([
    "main-root",
    "main-subdir",
    "sibling-worktree",
    "worktree-root",
    "worktree-subdir",
  ]);
});

test("find --kind message supports worktree-scoped filtering", () => {
  const repoRoot = "/tmp/scoped-project";
  const targetWorktreeRoot = "/tmp/scoped-project.worktrees/feat-a";
  const siblingWorktreeRoot = "/tmp/scoped-project.worktrees/fix-b";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-target-root.jsonl",
      contents: makeSessionJsonl({
        threadId: "target-root",
        title: "Target worktree root",
        cwd: targetWorktreeRoot,
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-target-subdir.jsonl",
      contents: makeSessionJsonl({
        threadId: "target-subdir",
        title: "Target worktree subdir",
        cwd: `${targetWorktreeRoot}/packages/app`,
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-sibling.jsonl",
      contents: makeSessionJsonl({
        threadId: "sibling-worktree",
        title: "Sibling worktree",
        cwd: siblingWorktreeRoot,
        messages: [{ timestamp: "2026-04-11T00:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    [
      "--json",
      "--refresh",
      "find",
      "shared scope needle",
      "--kind",
      "message",
      "--worktree",
      targetWorktreeRoot,
      "--limit",
      "10",
    ],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<{ thread_id: string }> };
  };
  expect(payload.data.results.map((row) => row.thread_id).sort()).toEqual(["target-root", "target-subdir"]);
});

test("recent supports repo-scoped filtering across repo and worktrees", () => {
  const repoRoot = "/tmp/scoped-project";
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-main.jsonl",
      contents: makeSessionJsonl({
        threadId: "main-root",
        title: "Main root",
        cwd: repoRoot,
        messages: [{ timestamp: "2026-04-11T03:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-worktree.jsonl",
      contents: makeSessionJsonl({
        threadId: "worktree-root",
        title: "Worktree root",
        cwd: "/tmp/scoped-project.worktrees/feat-a",
        messages: [{ timestamp: "2026-04-11T02:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
    {
      fileName: "rollout-other.jsonl",
      contents: makeSessionJsonl({
        threadId: "other-project",
        title: "Other project",
        cwd: "/tmp/other-project",
        messages: [{ timestamp: "2026-04-11T01:00:00.000Z", role: "user", text: "shared scope needle" }],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "recent", "--repo", repoRoot, "--limit", "10"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<{ thread_id: string }> };
  };
  expect(payload.data.results.map((row) => row.thread_id).sort()).toEqual(["main-root", "worktree-root"]);
});

test("repo and worktree scope options are mutually exclusive", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    [
      "--json",
      "--refresh",
      "find",
      "notify_url",
      "--repo",
      "/tmp/scoped-project",
      "--worktree",
      "/tmp/scoped-project.worktrees/feat-a",
    ],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("invalid-argument");
  expect(payload.error.message).toBe("Use only one of --cwd, --repo, or --worktree.");
});

test("inspect paths scope options are mutually exclusive", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    [
      "--json",
      "--refresh",
      "inspect",
      "paths",
      "--repo",
      "/tmp/scoped-project",
      "--worktree",
      "/tmp/scoped-project.worktrees/feat-a",
    ],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("invalid-argument");
  expect(payload.error.message).toBe("Use only one of --cwd, --repo, or --worktree.");
});

test("bare cli output stays compact and task-oriented", () => {
  const result = spawnSync("bun", ["run", cliEntry], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Local CLI for searching and reading agent session history.");
  expect(result.stdout).toContain("ath inspect paths --match mercpay");
  expect(result.stdout).toContain('ath find "error handling" --repo /path/to/repo');
  expect(result.stdout).toContain("Commands");
  expect(result.stdout).toContain("find <query>");
  expect(result.stdout).toContain("inspect <subcommand>");
  expect(result.stdout).toContain("ath --help");
  expect(result.stdout).not.toContain("OPTIONS");
  expect(result.stdout).not.toContain("--wizard");
});

test("find supports absolute time filters", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const visible = runCli(
    ["--json", "--refresh", "find", "notify_url", "--kind", "thread", "--since", "2025-01-01T00:00:00.000Z"],
    sourceRoot,
    indexDb,
  );
  expect(visible.status).toBe(0);
  const visiblePayload = JSON.parse(visible.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(visiblePayload.data.results.length).toBeGreaterThan(0);

  const hidden = runCli(
    ["--json", "find", "notify_url", "--kind", "thread", "--since", "2099-01-01T00:00:00.000Z"],
    sourceRoot,
    indexDb,
  );
  expect(hidden.status).toBe(0);
  const hiddenPayload = JSON.parse(hidden.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(hiddenPayload.data.results).toHaveLength(0);
});

test("recent lists threads in updated order with first user message summary", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "recent", "--limit", "5"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data.results[0]?.first_user_message).toBe("How should I normalize notify_url for epay callbacks?");
  expect("snippet" in (payload.data.results[0] ?? {})).toBe(false);
});

test("recent human output stays compact and normalizes second-based thread timestamps", () => {
  const sourceRoot = makeFakeSourceRootWithThreadTimes({
    createdAt: 1_744_338_552,
    updatedAt: 1_744_338_610,
  });
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--refresh", "recent", "--limit", "5"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("[thread] thread:thread-epay-fix");
  expect(result.stdout).toContain("How should I normalize notify_url for epay callbacks?");
  expect(result.stdout).toContain("2025-04-11T02:30:10.000Z");
  expect(result.stdout).not.toContain("1970-");
  expect(result.stdout).not.toContain("Fix epay callback normalize bug");
});

test("legacy second-based indexes are rebuilt into the current incremental schema on first sync", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  createLegacyReadyIndexDb(sourceRoot, indexDb, {
    title: "legacy title",
    firstUserMessage: "legacy summary",
  });

  const result = runCli(["--json", "recent", "--limit", "5", "--since", "3650d"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data.results[0]?.updated_at).toBe("2025-04-11T02:30:10.000Z");
});

test("recent supports relative time filters", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const visible = runCli(["--json", "--refresh", "recent", "--since", "3650d"], sourceRoot, indexDb);
  expect(visible.status).toBe(0);
  const visiblePayload = JSON.parse(visible.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(visiblePayload.data.results.length).toBeGreaterThan(0);

  const hidden = runCli(["--json", "recent", "--since", "1m"], sourceRoot, indexDb);
  expect(hidden.status).toBe(0);
  const hiddenPayload = JSON.parse(hidden.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(hiddenPayload.data.results).toHaveLength(0);
});

test("json output is compact by default", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "inspect", "source"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  expect(result.stdout.startsWith("{\"ok\":true,")).toBe(true);
});

test("help output remains available through the effect CLI shell", () => {
  const result = runRawCli(["--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ath");
  expect(result.stdout).toContain("find");
  expect(result.stdout).toContain("recent");
  expect(result.stdout).toContain("open");
  expect(result.stdout).toContain("inspect");
});

test("global options are accepted before the subcommand", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runRawCli([
    "--source-root",
    sourceRoot,
    "--index-db",
    indexDb,
    "--json",
    "inspect",
    "source",
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(payload.ok).toBe(true);
  expect(payload.data.sourceRoot).toBe(sourceRoot);
});

test("global value options with = syntax are accepted before the subcommand", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runRawCli([
    `--source-root=${sourceRoot}`,
    `--index-db=${indexDb}`,
    "--json",
    "inspect",
    "source",
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(payload.ok).toBe(true);
  expect(payload.data.sourceRoot).toBe(sourceRoot);
  expect(payload.data.indexDb).toBe(indexDb);
});

test("missing global option values before the subcommand fail instead of being ignored", () => {
  const result = runRawCli(["--source-root", "inspect", "source", "--json"]);

  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("\"ok\":true");
});

test("version output remains available through the effect CLI shell", () => {
  const result = runRawCli(["--version"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0.1.0");
});

test("subcommand help stays on the intended command surface", () => {
  const result = runRawCli(["find", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("$ find");
  expect(result.stdout).toContain("<query>");
  expect(result.stdout).toContain("--limit integer");
});

test("inspect help enumerates supported subjects", () => {
  const result = runRawCli(["inspect", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect");
  expect(result.stdout).toContain("Inspect source state, index state, one thread, or observed path scopes.");
  expect(result.stdout).toContain("Subcommands");
  expect(result.stdout).toContain("source");
  expect(result.stdout).toContain("index");
  expect(result.stdout).toContain("thread");
  expect(result.stdout).toContain("paths");
  expect(result.stdout).toContain("ath inspect <subcommand> --help");
  expect(result.stdout).toContain("ath inspect paths --help");
  expect(result.stdout).not.toContain("--repo text");
  expect(result.stdout).not.toContain("Required only for `thread`");
  expect(result.stdout).not.toContain("COMMANDS");
});

test("inspect source help omits path-scope filters", () => {
  const result = runRawCli(["inspect", "source", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect source");
  expect(result.stdout).toContain("Usage");
  expect(result.stdout).toContain("ath inspect source");
  expect(result.stdout).not.toContain("--repo text");
  expect(result.stdout).not.toContain("--worktree text");
  expect(result.stdout).not.toContain("--cwd text");
});

test("inspect paths help isolates scope filters to the paths subcommand", () => {
  const result = runRawCli(["inspect", "paths", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect paths");
  expect(result.stdout).toContain("Usage");
  expect(result.stdout).toContain("ath inspect paths --repo /path/to/repo");
  expect(result.stdout).toContain("--repo <path>");
  expect(result.stdout).toContain("--worktree <path>");
  expect(result.stdout).toContain("--cwd <path>");
  expect(result.stdout).toContain("Scope flags here filter observed path rows only.");
});

test("bare inspect output stays compact and task-oriented", () => {
  const result = runRawCli(["inspect"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Inspect source state, index state, one thread, or observed path scopes.");
  expect(result.stdout).toContain("Subcommands");
  expect(result.stdout).toContain("ath inspect paths --match mercpay");
  expect(result.stdout).toContain("ath inspect <subcommand> --help");
  expect(result.stdout).not.toContain("--repo text");
});

test("admin help enumerates supported actions", () => {
  const result = runRawCli(["admin", "--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("$ admin");
  expect(result.stdout).toContain("init, reindex, sql");
  expect(result.stdout).toContain("Used only by `sql`");
});

test("find rejects non-positive limit values", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "find", "notify_url", "--limit", "0"], sourceRoot, indexDb);

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("invalid-argument");
  expect(payload.error.message).toBe("Invalid --limit.");
});

test("open rejects negative before values for message targets", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "open", "thread-epay-fix:1", "--before", "-1"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("invalid-argument");
  expect(payload.error.message).toBe("Invalid --before.");
});

test("admin sql rejects mutating pragma statements", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "admin", "sql", "PRAGMA journal_mode=WAL"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.ok).toBe(false);
});

test("admin sql returns rows instead of an unevaluated effect description", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "admin", "sql", "SELECT 1 AS n"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(payload.ok).toBe(true);
  expect(payload.data).toEqual([{ n: 1 }]);
});

test("admin sql rejects mutating common table expressions", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "admin", "sql", "WITH keep AS (SELECT 1) DELETE FROM threads RETURNING thread_id"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.ok).toBe(false);
  expect(payload.error.message).toContain("Only read-only SELECT and WITH queries are allowed.");
});

test("open rejects negative before values", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "open", "thread-epay-fix:1", "--before", "-1"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.error.code).toBe("invalid-argument");
  expect(payload.error.message).toBe("Invalid --before.");
});

test("invalid config file surfaces a typed config error", () => {
  const sourceRoot = makeFakeSourceRoot();
  const configHome = mkdtempSync(join(tmpdir(), "agent-threads-config-"));
  writeFileSync(join(configHome, "config.json"), "{invalid json", "utf8");

  const result = spawnSync("bun", ["run", cliEntry, "inspect", "source", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_THREADS_CONFIG_HOME: configHome,
      AGENT_THREADS_INDEX_DB: join(sourceRoot, "cache", "agent-threads", "index.sqlite"),
    },
  });

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.ok).toBe(false);
  expect(payload.error.code).toBe("invalid-config");
});

test("export write failures surface a typed export error", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "export", "thread-epay-fix", "--out", "/dev/null/out.md"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    ok: false;
    error: { code: string; message: string };
  };
  expect(payload.ok).toBe(false);
  expect(payload.error.code).toBe("export-write-failed");
});

test("fallback thread id extraction uses the trailing rollout UUID", () => {
  const sourceRoot = makeSourceRootWithoutSessionMeta();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "inspect", "thread", "019d78b3-f25e-7703-af77-6e0c9897699e"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { thread: Record<string, unknown> };
  };
  expect(payload.data.thread.thread_id).toBe("019d78b3-f25e-7703-af77-6e0c9897699e");
  expect(payload.data.thread.first_user_message).toBe("Find the old payment callback fix.");
});

test("late session_meta rebinds earlier messages to the canonical thread id", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-mismatch.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T02:42:40.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "needle before meta",
        },
      }),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "correct-thread",
          cwd: "/tmp/rebind",
          source: "cli",
          model_provider: "Spencer",
          thread_name: "Correct thread",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:42:55.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final_answer",
          message: "message after meta",
        },
      }),
      "",
    ].join("\n"),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const searchResult = runCli(
    ["--json", "--refresh", "find", "needle before meta", "--kind", "message", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(searchResult.status).toBe(0);
  const searchPayload = JSON.parse(searchResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(searchPayload.data.results).toHaveLength(1);
  expect(searchPayload.data.results[0]?.thread_id).toBe("correct-thread");
  expect(searchPayload.data.results[0]?.target).toBe("thread:correct-thread:1");

  const openResult = runCli(
    ["--json", "open", "correct-thread:1", "--before", "0", "--after", "1"],
    sourceRoot,
    indexDb,
  );

  expect(openResult.status).toBe(0);
  const openPayload = JSON.parse(openResult.stdout) as {
    ok: true;
    data: { anchor: Record<string, unknown>; messages: Array<Record<string, unknown>> };
  };
  expect(openPayload.data.anchor.thread_id).toBe("correct-thread");
  expect(openPayload.data.messages.map((message) => message.thread_id)).toEqual([
    "correct-thread",
    "correct-thread",
  ]);
});

test("consecutive identical messages are preserved when they are separate events", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-repeat.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T02:42:40.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "yes" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:42:41.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "yes" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:42:42.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "ok" },
      }),
      "",
    ].join("\n"),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "--refresh", "open", "repeat", "--format", "messages"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { thread: Record<string, unknown>; messages: Array<Record<string, unknown>> };
  };
  expect(payload.data.thread.message_count).toBe(3);
  expect(payload.data.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
});

test("rebuild aggregates messages across multiple session files for one thread", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-continued-1.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "continued",
            cwd: "/tmp/continued",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Continued thread",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:42:40.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "first question" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:42:41.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "first answer" },
        }),
        "",
      ].join("\n"),
    },
    {
      fileName: "rollout-continued-2.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "continued",
            cwd: "/tmp/continued",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Continued thread",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:40.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "follow up question" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:41.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "follow up answer" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T02:43:42.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "final question" },
        }),
        "",
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const inspectThread = runCli(["--json", "--refresh", "inspect", "thread", "continued"], sourceRoot, indexDb);
  expect(inspectThread.status).toBe(0);
  const threadPayload = JSON.parse(inspectThread.stdout) as {
    ok: true;
    data: { thread: Record<string, unknown> };
  };
  expect(threadPayload.data.thread.message_count).toBe(5);
  expect(threadPayload.data.thread.user_message_count).toBe(3);
  expect(threadPayload.data.thread.assistant_message_count).toBe(2);

  const openThread = runCli(["--json", "open", "continued", "--format", "messages", "--full"], sourceRoot, indexDb);
  expect(openThread.status).toBe(0);
  const openPayload = JSON.parse(openThread.stdout) as {
    ok: true;
    data: { messages: Array<Record<string, unknown>> };
  };
  expect(openPayload.data.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5]);

  const inspectIndex = runCli(["--json", "inspect", "index"], sourceRoot, indexDb);
  expect(inspectIndex.status).toBe(0);
  const indexPayload = JSON.parse(inspectIndex.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(indexPayload.data.thread_count).toBe(1);
  expect(indexPayload.data.message_count).toBe(5);
}, 15_000);

test("human-readable message output preserves multiline full text", () => {
  const longMessage = ["Line one", "", "Line two", "", `${"x".repeat(260)}TAIL_MARKER`].join("\n");
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-long.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T02:42:40.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "show me the full answer" },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T02:42:42.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: longMessage },
      }),
      "",
    ].join("\n"),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--refresh", "open", "long", "--format", "messages", "--full"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Line one\n\nLine two");
  expect(result.stdout).toContain("TAIL_MARKER");
});

test("open messages defaults to a bounded transcript excerpt", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-bounded.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T04:00:00.000Z",
        type: "session_meta",
        payload: { id: "bounded", title: "Bounded thread" },
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-04-11T04:00:${String(index).padStart(2, "0")}.000Z`,
          type: "event_msg",
          payload: {
            type: index % 2 === 0 ? "user_message" : "agent_message",
            message: `${index % 2 === 0 ? "user" : "assistant"} message ${index}`,
          },
        }),
      ),
      "",
    ].join("\n"),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "open", "bounded", "--format", "messages"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { truncated: boolean; returnedMessageCount: number; omittedMessageCount: number; messages: Array<Record<string, unknown>> };
  };
  expect(payload.data.truncated).toBe(true);
  expect(payload.data.returnedMessageCount).toBe(8);
  expect(payload.data.omittedMessageCount).toBe(4);
  expect(payload.data.messages[0]?.seq).toBe(1);
  expect(payload.data.messages[payload.data.messages.length - 1]?.seq).toBe(12);
});

test("open messages --full returns the complete thread transcript", () => {
  const sourceRoot = makeSourceRootFromSessionFile(
    "rollout-full.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T04:10:00.000Z",
        type: "session_meta",
        payload: { id: "full-thread", title: "Full thread" },
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-04-11T04:10:${String(index).padStart(2, "0")}.000Z`,
          type: "event_msg",
          payload: {
            type: index % 2 === 0 ? "user_message" : "agent_message",
            message: `${index % 2 === 0 ? "user" : "assistant"} full message ${index}`,
          },
        }),
      ),
      "",
    ].join("\n"),
  );
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "open", "full-thread", "--format", "messages", "--full"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { truncated: boolean; omittedMessageCount: number; messages: Array<Record<string, unknown>> };
  };
  expect(payload.data.truncated).toBe(false);
  expect(payload.data.omittedMessageCount).toBe(0);
  expect(payload.data.messages).toHaveLength(10);
});

test("inspect source reflects agent-threads source-based naming", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "inspect", "source"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(payload.data.sourceId).toBe("local-codex");
  expect(payload.data.sourceKind).toBe("codex");
  expect(payload.data.sourceRoot).toBe(sourceRoot);
});

test("find thread results hide noisy transcript-only matches when clean matches exist", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-noisy.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-04-11T03:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "# AGENTS.md instructions\n\n>>> APPROVAL REQUEST START\npayment callback incident",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:10:05.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "tool exec_command result: payment callback log" },
        }),
        "",
      ].join("\n"),
    },
    {
      fileName: "rollout-clean.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-04-11T03:11:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "How do I fix the payment callback?" },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:11:05.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Normalize the payment callback URL." },
        }),
        "",
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "payment", "--kind", "thread", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("clean");
});

test("find thread results still fall back to noisy transcript-only matches when they are the only hits", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-noisy-only.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-04-11T03:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "# AGENTS.md instructions\n\n>>> APPROVAL REQUEST START\npayment callback incident",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:10:05.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "tool exec_command result: payment callback log" },
        }),
        "",
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "payment", "--kind", "thread", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("noisy-only");
});

test("find thread search does not treat short ascii queries as arbitrary substrings inside other words", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-path-noise.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "path-noise",
            cwd: "/tmp/path-noise",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "Path cleanup",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:10:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Please update the path handling flow." },
        }),
        "",
      ].join("\n"),
    },
    {
      fileName: "rollout-ath-token.jsonl",
      contents: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "ath-token",
            cwd: "/tmp/ath-token",
            source: "cli",
            model_provider: "Spencer",
            thread_name: "ath install help",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-11T03:11:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "How do I install ath locally?" },
        }),
        "",
      ].join("\n"),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "find", "ath", "--kind", "thread", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("ath-token");
});

test("changing source root with a shared index triggers a rebuild", () => {
  const firstRoot = makeFakeSourceRoot();
  const secondRoot = makeSourceRootFromSessionFile(
    "rollout-second.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-04-11T03:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Find the second thread." },
      }),
      JSON.stringify({
        timestamp: "2026-04-11T03:00:10.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Second thread indexed." },
      }),
      "",
    ].join("\n"),
  );
  const sharedIndexDb = join(tmpdir(), `agent-threads-shared-${Date.now()}.sqlite`);

  const firstResult = runCli(["--json", "--refresh", "find", "callback", "--kind", "thread"], firstRoot, sharedIndexDb);
  expect(firstResult.status).toBe(0);

  const secondResult = runCli(["--json", "find", "second", "--kind", "thread"], secondRoot, sharedIndexDb);
  expect(secondResult.status).toBe(0);
  const payload = JSON.parse(secondResult.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.data.results).toHaveLength(1);
  expect(payload.data.results[0]?.thread_id).toBe("second");
}, 15_000);

test("concurrent first-run queries wait on the rebuild lock instead of failing", async () => {
  for (let round = 0; round < 2; round += 1) {
    const sourceRoot = makeFakeSourceRoot();
    const indexDb = join(tmpdir(), `agent-threads-concurrent-${Date.now()}-${round}.sqlite`);

    const [left, right] = await Promise.all([
      runCliAsync(["--json", "inspect", "index"], sourceRoot, indexDb),
      runCliAsync(["--json", "inspect", "index"], sourceRoot, indexDb),
    ]);

    expect(left.status).toBe(0);
    expect(right.status).toBe(0);
    expect(JSON.parse(left.stdout).ok).toBe(true);
    expect(JSON.parse(right.stdout).ok).toBe(true);
  }
}, 15_000);

test("ready-index read queries ignore an active writer lock and return stale results immediately", async () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(tmpdir(), `agent-threads-active-lock-${Date.now()}.sqlite`);

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const newThreadId = "thread-lock-stale";
  const newSessionPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-thread-lock-stale.jsonl");
  writeFileSync(
    newSessionPath,
    makeSessionJsonl({
      threadId: newThreadId,
      title: "Lock stale thread",
      messages: [
        {
          timestamp: "2026-04-11T05:00:00.000Z",
          role: "user",
          text: "show me the stale lock behavior",
        },
        {
          timestamp: "2026-04-11T05:00:01.000Z",
          role: "assistant",
          text: "the stale index should still answer immediately",
        },
      ],
    }),
    "utf8",
  );
  insertStateThread({
    dbPath: join(sourceRoot, "state_5.sqlite"),
    threadId: newThreadId,
    rolloutPath: newSessionPath,
    cwd: "/tmp/project",
    title: "Lock stale thread",
    updatedAt: 1_744_347_201_000,
    firstUserMessage: "show me the stale lock behavior",
  });
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    },
    {
      id: newThreadId,
      thread_name: "Lock stale thread",
      updated_at: "2026-04-11T05:00:01.000Z",
    },
  ]);

  const lockFile = `${indexDb}.lock`;
  writeFileSync(lockFile, `999999 ${new Date().toISOString()} incremental\n`, "utf8");

  const releaseTimer = setTimeout(() => {
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the lock file has already been removed.
    }
  }, 5_000);

  const startedAt = Date.now();
  try {
    const result = await runCliAsync(["--json", "find", "notify_url", "--kind", "message"], sourceRoot, indexDb);
    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      data: { results: Array<Record<string, unknown>> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
    expect(payload.data.results.some((row) => row.thread_id === newThreadId)).toBe(false);
  } finally {
    clearTimeout(releaseTimer);
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the file is already gone.
    }
  }
}, 15_000);

test("strict refresh queries wait for an active writer lock and then observe newly synced threads", async () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(tmpdir(), `agent-threads-refresh-lock-${Date.now()}.sqlite`);

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const newThreadId = "thread-refresh-after-lock";
  const newSessionPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-thread-refresh-after-lock.jsonl");
  writeFileSync(
    newSessionPath,
    makeSessionJsonl({
      threadId: newThreadId,
      title: "Strict refresh thread",
      messages: [
        {
          timestamp: "2026-04-11T06:00:00.000Z",
          role: "user",
          text: "strict refresh should wait for the writer",
        },
        {
          timestamp: "2026-04-11T06:00:01.000Z",
          role: "assistant",
          text: "the strict path should see this after the lock clears",
        },
      ],
    }),
    "utf8",
  );
  insertStateThread({
    dbPath: join(sourceRoot, "state_5.sqlite"),
    threadId: newThreadId,
    rolloutPath: newSessionPath,
    cwd: "/tmp/project",
    title: "Strict refresh thread",
    updatedAt: 1_744_350_401_000,
    firstUserMessage: "strict refresh should wait for the writer",
  });
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    },
    {
      id: newThreadId,
      thread_name: "Strict refresh thread",
      updated_at: "2026-04-11T06:00:01.000Z",
    },
  ]);

  const lockFile = `${indexDb}.lock`;
  writeFileSync(lockFile, `999999 ${new Date().toISOString()} incremental\n`, "utf8");

  const releaseTimer = setTimeout(() => {
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the lock file has already been removed.
    }
  }, 1_500);

  const startedAt = Date.now();
  try {
    const result = await runCliAsync(["--json", "--refresh", "inspect", "thread", newThreadId], sourceRoot, indexDb);
    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      data: { thread: Record<string, unknown> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.thread.thread_id).toBe(newThreadId);
  } finally {
    clearTimeout(releaseTimer);
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the file is already gone.
    }
  }
}, 15_000);

test("exact thread lookups retry after a stale miss when an active writer is present", async () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(tmpdir(), `agent-threads-exact-retry-${Date.now()}.sqlite`);

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const newThreadId = "thread-retry-after-stale-miss";
  const newSessionPath = join(
    sourceRoot,
    "sessions",
    "2026",
    "04",
    "11",
    "rollout-thread-retry-after-stale-miss.jsonl",
  );
  writeFileSync(
    newSessionPath,
    makeSessionJsonl({
      threadId: newThreadId,
      title: "Retry after stale miss",
      messages: [
        {
          timestamp: "2026-04-11T07:00:00.000Z",
          role: "user",
          text: "please find this exact thread after the writer finishes",
        },
        {
          timestamp: "2026-04-11T07:00:01.000Z",
          role: "assistant",
          text: "the retry path should recover this exact lookup",
        },
      ],
    }),
    "utf8",
  );
  insertStateThread({
    dbPath: join(sourceRoot, "state_5.sqlite"),
    threadId: newThreadId,
    rolloutPath: newSessionPath,
    cwd: "/tmp/project",
    title: "Retry after stale miss",
    updatedAt: 1_744_354_001_000,
    firstUserMessage: "please find this exact thread after the writer finishes",
  });
  writeSessionIndex(sourceRoot, [
    {
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    },
    {
      id: newThreadId,
      thread_name: "Retry after stale miss",
      updated_at: "2026-04-11T07:00:01.000Z",
    },
  ]);

  const lockFile = `${indexDb}.lock`;
  writeFileSync(lockFile, `999999 ${new Date().toISOString()} incremental\n`, "utf8");

  const releaseTimer = setTimeout(() => {
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the lock file has already been removed.
    }
  }, 1_500);

  const startedAt = Date.now();
  try {
    const result = await runCliAsync(["--json", "inspect", "thread", newThreadId], sourceRoot, indexDb);
    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      data: { thread: Record<string, unknown> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.thread.thread_id).toBe(newThreadId);
  } finally {
    clearTimeout(releaseTimer);
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the file is already gone.
    }
  }
}, 15_000);

test("invalid ready indexes rebuild successfully when no lock file exists yet", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(tmpdir(), `agent-threads-invalid-ready-${Date.now()}.sqlite`);

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const db = new Database(indexDb);
  try {
    db.exec("UPDATE threads SET message_count = 0");
  } finally {
    db.close();
  }

  const result = runCli(["--json", "find", "notify_url", "--kind", "message"], sourceRoot, indexDb);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { results: Array<Record<string, unknown>> };
  };
  expect(payload.ok).toBe(true);
  expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
});

test("default configured read-only queries fall back to a temporary writable index", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexHome = mkdtempSync(join(tmpdir(), "agent-threads-readonly-"));
  const indexDb = join(indexHome, "index.sqlite");

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const db = new Database(indexDb);
  try {
    db.exec("UPDATE threads SET message_count = 0");
  } finally {
    db.close();
  }

  const configHome = mkdtempSync(join(tmpdir(), "agent-threads-config-"));
  writeFileSync(
    join(configHome, "config.json"),
    `${JSON.stringify(
      {
        defaultSource: "local-codex",
        indexDb,
        sources: [
          {
            id: "local-codex",
            kind: "codex",
            root: sourceRoot,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  chmodSync(indexHome, 0o555);
  try {
    const result = spawnSync(
      "bun",
      ["run", cliEntry, "--json", "find", "notify_url", "--kind", "message"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_THREADS_CONFIG_HOME: configHome,
        },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      data: { results: Array<Record<string, unknown>> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.results[0]?.thread_id).toBe("thread-epay-fix");
  } finally {
    chmodSync(indexHome, 0o755);
  }
});

test("ready indexes skip the sync lock when the source manifest is unchanged", async () => {
  const sourceRoot = makeTrustedManifestSourceRoot();
  const indexDb = join(tmpdir(), `agent-threads-ready-index-${Date.now()}.sqlite`);

  const initial = runCli(["--json", "--refresh", "inspect", "index"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);

  const lockFile = `${indexDb}.lock`;
  writeFileSync(lockFile, "1234 2026-04-12T00:00:00.000Z\n", "utf8");

  const queryPromise = runCliAsync(["--json", "inspect", "index"], sourceRoot, indexDb);
  const raced = await Promise.race([
    queryPromise.then((result) => ({ kind: "done" as const, result })),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 3_000)),
  ]);

  try {
    expect(raced.kind).toBe("done");
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the process already removed the lock file.
    }
    const result = await queryPromise;
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  }
});

test("multi-file threads keep the previous index when any sibling shard is unstable", () => {
  const sourceRoot = makeSourceRootFromSessionFiles([
    {
      fileName: "rollout-continued-1.jsonl",
      contents: makeSessionJsonl({
        threadId: "continued",
        title: "Continued thread",
        messages: [
          {
            timestamp: "2026-04-11T02:43:30.000Z",
            role: "user",
            text: "initial question",
          },
          {
            timestamp: "2026-04-11T02:43:31.000Z",
            role: "assistant",
            text: "initial answer",
          },
        ],
      }),
    },
    {
      fileName: "rollout-continued-2.jsonl",
      contents: makeSessionJsonl({
        threadId: "continued",
        title: "Continued thread",
        messages: [
          {
            timestamp: "2026-04-11T02:43:40.000Z",
            role: "user",
            text: "follow up question",
          },
          {
            timestamp: "2026-04-11T02:43:41.000Z",
            role: "assistant",
            text: "follow up answer",
          },
        ],
      }),
    },
  ]);
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const initial = runCli(["--json", "--refresh", "open", "continued", "--format", "messages", "--full"], sourceRoot, indexDb);
  expect(initial.status).toBe(0);
  const initialPayload = JSON.parse(initial.stdout) as {
    ok: true;
    data: { messages: Array<{ text: string }> };
  };
  expect(initialPayload.data.messages).toHaveLength(4);

  const firstShardPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-continued-1.jsonl");
  const secondShardPath = join(sourceRoot, "sessions", "2026", "04", "11", "rollout-continued-2.jsonl");

  writeFileSync(
    firstShardPath,
    makeSessionJsonl({
      threadId: "continued",
      title: "Continued thread",
      messages: [
        {
          timestamp: "2026-04-11T02:43:30.000Z",
          role: "user",
          text: "initial question",
        },
        {
          timestamp: "2026-04-11T02:43:31.000Z",
          role: "assistant",
          text: "initial answer",
        },
        {
          timestamp: "2026-04-11T02:43:32.000Z",
          role: "assistant",
          text: "new stable answer",
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    secondShardPath,
    `${makeSessionJsonl({
      threadId: "continued",
      title: "Continued thread",
      messages: [
        {
          timestamp: "2026-04-11T02:43:40.000Z",
          role: "user",
          text: "follow up question",
        },
        {
          timestamp: "2026-04-11T02:43:41.000Z",
          role: "assistant",
          text: "follow up answer",
        },
        {
          timestamp: "2026-04-11T02:43:42.000Z",
          role: "user",
          text: "partial incoming",
        },
      ],
    })}\n{"timestamp":"2026-04-11T02:43:43.000Z","type":"event_msg","payload":{"type":"agent_message","message":"partial"`,
    "utf8",
  );

  const whileUnstable = runCli(["--json", "open", "continued", "--format", "messages", "--full"], sourceRoot, indexDb);
  expect(whileUnstable.status).toBe(0);
  const unstablePayload = JSON.parse(whileUnstable.stdout) as {
    ok: true;
    data: { messages: Array<{ text: string }> };
  };
  expect(unstablePayload.data.messages.map((message) => message.text)).toEqual([
    "initial question",
    "initial answer",
    "follow up question",
    "follow up answer",
  ]);

  writeFileSync(
    secondShardPath,
    makeSessionJsonl({
      threadId: "continued",
      title: "Continued thread",
      messages: [
        {
          timestamp: "2026-04-11T02:43:40.000Z",
          role: "user",
          text: "follow up question",
        },
        {
          timestamp: "2026-04-11T02:43:41.000Z",
          role: "assistant",
          text: "follow up answer",
        },
        {
          timestamp: "2026-04-11T02:43:42.000Z",
          role: "user",
          text: "partial incoming",
        },
        {
          timestamp: "2026-04-11T02:43:43.000Z",
          role: "assistant",
          text: "partial resolved",
        },
      ],
    }),
    "utf8",
  );

  const afterRecovery = runCli(["--json", "open", "continued", "--format", "messages", "--full"], sourceRoot, indexDb);
  expect(afterRecovery.status).toBe(0);
  const recoveredPayload = JSON.parse(afterRecovery.stdout) as {
    ok: true;
    data: { messages: Array<{ text: string }> };
  };
  expect(recoveredPayload.data.messages.map((message) => message.text)).toEqual([
    "initial question",
    "initial answer",
    "new stable answer",
    "follow up question",
    "follow up answer",
    "partial incoming",
    "partial resolved",
  ]);
});
