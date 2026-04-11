import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cliEntry = join(projectRoot, "src", "index.ts");
const fixtureSession = readFileSync(join(projectRoot, "test", "fixtures", "sample-session.jsonl"), "utf8");

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

function createThreadsTable(dbPath: string): void {
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
      1_744_338_552_000,
      1_744_338_610_000,
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
  createThreadsTable(join(root, "state_5.sqlite"));
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

test("doctor reports offline local state without auth", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");
  const result = runCli(["--json", "doctor"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as { ok: true; data: Record<string, unknown> };
  expect(payload.ok).toBe(true);
  expect(payload.data.authRequired).toBe(false);
  expect(payload.data.stateDbExists).toBe(true);
  expect(payload.data.sessionFileCount).toBe(1);
});

test("threads search and messages context work against rebuilt local index", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const searchResult = runCli(
    ["--json", "--refresh", "threads", "search", "notify_url", "--limit", "5"],
    sourceRoot,
    indexDb,
  );
  expect(searchResult.status).toBe(0);
  const searchPayload = JSON.parse(searchResult.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(searchPayload.ok).toBe(true);
  expect(searchPayload.data[0]?.thread_id).toBe("thread-epay-fix");

  const contextResult = runCli(
    ["--json", "messages", "context", "thread-epay-fix", "--message", "2", "--before", "1", "--after", "1"],
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

  const threadResult = runCli(["--json", "threads", "get", "thread-epay-fix"], sourceRoot, indexDb);
  expect(threadResult.status).toBe(0);
  const threadPayload = JSON.parse(threadResult.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(threadPayload.data.title).toBe("How should I normalize notify_url for epay callbacks?");
});

test("threads search json returns a compact agent-first shape", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "threads", "search", "notify_url", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(payload.data[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data[0]?.message_snippet).toBeDefined();
  expect(payload.data[0]?.sandbox_policy).toBeUndefined();
  expect(payload.data[0]?.source_file).toBeUndefined();
});

test("messages search json returns snippets instead of full text", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "messages", "search", "notify_url", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(payload.data[0]?.thread_id).toBe("thread-epay-fix");
  expect(payload.data[0]?.text_snippet).toBeDefined();
  expect(payload.data[0]?.text).toBeUndefined();
});

test("json output is compact by default", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "doctor"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  expect(result.stdout.startsWith("{\"ok\":true,")).toBe(true);
});

test("request sql rejects mutating pragma statements", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "request", "sql", "PRAGMA journal_mode=WAL"],
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

test("request sql rejects mutating common table expressions", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "request", "sql", "WITH keep AS (SELECT 1) DELETE FROM threads RETURNING thread_id"],
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

test("fallback thread id extraction uses the trailing rollout UUID", () => {
  const sourceRoot = makeSourceRootWithoutSessionMeta();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(
    ["--json", "--refresh", "threads", "get", "019d78b3-f25e-7703-af77-6e0c9897699e"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(payload.data.thread_id).toBe("019d78b3-f25e-7703-af77-6e0c9897699e");
  expect(payload.data.first_user_message).toBe("Find the old payment callback fix.");
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

  const result = runCli(["--json", "--refresh", "threads", "open", "repeat", "--format", "messages"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: { thread: Record<string, unknown>; messages: Array<Record<string, unknown>> };
  };
  expect(payload.data.thread.message_count).toBe(3);
  expect(payload.data.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
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

  const result = runCli(["--refresh", "threads", "open", "long", "--format", "messages"], sourceRoot, indexDb);

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
    ["--json", "--refresh", "threads", "open", "bounded", "--format", "messages"],
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
    ["--json", "--refresh", "threads", "open", "full-thread", "--format", "messages", "--full"],
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

test("doctor reflects agent-threads source-based naming", () => {
  const sourceRoot = makeFakeSourceRoot();
  const indexDb = join(sourceRoot, "cache", "agent-threads", "index.sqlite");

  const result = runCli(["--json", "doctor"], sourceRoot, indexDb);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Record<string, unknown>;
  };
  expect(payload.data.sourceId).toBe("local-codex");
  expect(payload.data.sourceKind).toBe("codex");
  expect(payload.data.sourceRoot).toBe(sourceRoot);
});

test("search ranking pushes noisy transcript threads behind clean matches", () => {
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
    ["--json", "--refresh", "threads", "search", "payment", "--limit", "5"],
    sourceRoot,
    indexDb,
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(payload.data[0]?.thread_id).toBe("clean");
  expect(payload.data[1]?.thread_id).toBe("noisy");
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

  const firstResult = runCli(["--json", "--refresh", "threads", "list"], firstRoot, sharedIndexDb);
  expect(firstResult.status).toBe(0);

  const secondResult = runCli(["--json", "threads", "list"], secondRoot, sharedIndexDb);
  expect(secondResult.status).toBe(0);
  const payload = JSON.parse(secondResult.stdout) as {
    ok: true;
    data: Array<Record<string, unknown>>;
  };
  expect(payload.data).toHaveLength(1);
  expect(payload.data[0]?.thread_id).toBe("second");
});

test("concurrent first-run queries wait on the rebuild lock instead of failing", async () => {
  for (let round = 0; round < 5; round += 1) {
    const sourceRoot = makeFakeSourceRoot();
    const indexDb = join(tmpdir(), `agent-threads-concurrent-${Date.now()}-${round}.sqlite`);

    const [left, right] = await Promise.all([
      runCliAsync(["--json", "threads", "list"], sourceRoot, indexDb),
      runCliAsync(["--json", "threads", "list"], sourceRoot, indexDb),
    ]);

    expect(left.status).toBe(0);
    expect(right.status).toBe(0);
    expect(JSON.parse(left.stdout).ok).toBe(true);
    expect(JSON.parse(right.stdout).ok).toBe(true);
  }
});
