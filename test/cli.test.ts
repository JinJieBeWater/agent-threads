import { readFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
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

function makeFakeSourceRootWithThreadTimes(options?: {
  createdAt?: number;
  updatedAt?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-threads-test-"));
  mkdirSync(join(root, "sessions", "2026", "04", "11"), { recursive: true });
  mkdirSync(join(root, "archived_sessions"), { recursive: true });

  const sessionPath = join(root, "sessions", "2026", "04", "11", "rollout-thread-epay-fix.jsonl");
  writeFileSync(sessionPath, `${fixtureSession}\n`, "utf8");
  writeFileSync(
    join(root, "session_index.jsonl"),
    `${JSON.stringify({
      id: "thread-epay-fix",
      thread_name: "Fix epay callback normalize bug",
      updated_at: "2026-04-11T02:43:30.000Z",
    })}\n`,
    "utf8",
  );
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

test("recent reads legacy second-based index timestamps correctly without refresh", () => {
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
  expect(payload.data.results[0]?.thread_id).toBe("legacy-seconds");
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

test("bare cli output stays compact and task-oriented", () => {
  const result = spawnSync("bun", ["run", cliEntry], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Local CLI for searching and reading agent session history.");
  expect(result.stdout).toContain('ath find "error handling"');
  expect(result.stdout).toContain("Commands");
  expect(result.stdout).toContain("find <query>");
  expect(result.stdout).toContain("ath --help");
  expect(result.stdout).not.toContain("OPTIONS");
  expect(result.stdout).not.toContain("--wizard");
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
});

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
});

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
});

test("ready indexes do not wait on a rebuild lock for read-only queries", async () => {
  const sourceRoot = makeFakeSourceRoot();
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
    if (raced.kind === "done") {
      expect(raced.result.status).toBe(0);
      expect(JSON.parse(raced.result.stdout).ok).toBe(true);
    }
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      // Ignore cleanup races if the process already removed the lock file.
    }
    await queryPromise;
  }
});
