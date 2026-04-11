---
name: agent-threads
description: Search and read local agent conversation history with the `agent-threads` CLI. Use when Codex needs to find a past thread by title, message text, provider, or workspace; inspect the exact messages around a previous solution; export a useful conversation; or mine older local sessions for reusable patterns before turning them into a skill or workflow.
---

# Agent Threads

Use this skill when local agent history is the source of truth.

Maintain this skill in the standalone project, not in `~/.codex` directly:

```bash
<project-root>/.codex/skills/agent-threads
```

The global `~/.codex/skills/agent-threads` path should stay a symlink to that repo path.

## Quick Start

Verify the command exists first:

```bash
command -v agent-threads
```

If it is missing, install the local CLI from:

```bash
cd /path/to/agent-threads
make install-local
```

Run this first:

```bash
agent-threads --json doctor
```

This CLI is offline and read-only. No auth is required.

## Workflow

Use this order unless the user asks for something narrower:

1. Discover likely threads.
2. Open the most relevant thread.
3. Pull the exact message context.
4. Export or summarize the useful pattern.

Start broad:

```bash
agent-threads --json threads search "refactor pattern"
agent-threads --json threads list --limit 20
```

Read one thread:

```bash
agent-threads --json threads get <thread-id>
agent-threads --json threads open <thread-id> --format messages
agent-threads --json threads open <thread-id> --format messages --full
```

Zoom into the exact local context:

```bash
agent-threads --json messages search "retry strategy" --thread <thread-id>
agent-threads --json messages context <thread-id> --message <message-seq> --before 2 --after 3
```

Export when you need a durable artifact for later synthesis:

```bash
agent-threads --json export thread <thread-id> --format md --out /tmp/thread.md
```

## Safe Path

- Prefer `--json` when the output will feed more reasoning or another command.
- Prefer the default compact `--json` output; only use `--json-pretty` when a human is debugging the raw payload.
- Prefer `threads search` before `messages search` when the query is ambiguous.
- Prefer `messages context` after you already know the thread and approximate anchor.
- Use `threads related` when the first hit is close but not exact.
- Treat `threads open <thread-id> --format messages` as a high-context action. It now returns a bounded excerpt by default; add `--full` only when you explicitly want the whole transcript.
- Prefer `messages context` before `threads open --format messages --full` to avoid flooding the active context window.
- Prefer exporting one relevant thread over quoting many raw snippets.

## Raw Escape Hatch

Use raw SQL only when the high-level commands are insufficient:

```bash
agent-threads --json request sql "select thread_id, count(*) from messages group by 1 order by 2 desc limit 20"
```

Only use read-only `SELECT` or `WITH` SQL. Do not treat the generated index as the canonical source database schema.

## Do Not

- Do not modify source files with this tool.
- Do not rely on raw SQL first when `threads` or `messages` commands already cover the task.
- Do not quote long transcript chunks when a short excerpt plus thread id is enough.
- Do not assume search results are deduplicated for you; inspect the thread before reusing a pattern.
- Do not edit the global skill copy directly; edit the repo-managed skill and keep the global path as a symlink.

## Examples

```bash
agent-threads --json threads search "error handling"
```

```bash
agent-threads --json messages context <thread-id> --message <message-seq> --before 1 --after 2
```

```bash
agent-threads --json export thread <thread-id> --format md --out /tmp/agent-thread.md
```
