---
name: agent-threads
description: Search local agent conversation history with the `ath` CLI. Use when needed task context is missing from the current prompt, context window, or codebase but is likely available in prior local conversations.
---

# Agent Threads

Use this skill when local agent history is the source of truth. `ath` is offline, read-only, and defaults to `~/.codex`.

## Trigger Rules

Use this skill when the needed information is missing from the current prompt, current context window, or local codebase, and there is a strong reason to believe the missing context exists in prior local agent conversations.

Typical cases:

- The user refers to an earlier discussion, decision, plan, bug investigation, or requirement without repeating the details.
- The current repository does not contain the answer, or the answer would be slow or unreliable to reconstruct from code alone.
- The agent needs nearby message context around one historical statement instead of a full transcript.
- The agent wants one prior thread as reusable context for the current task.

Do not use this skill when the answer is already available in the current context or can be found quickly and reliably from the codebase or provided files.

## Quick Start

```bash
command -v ath
ath --json inspect source
```

If missing:

```bash
cd /path/to/agent-threads
make install-local
```

## Workflow

1. Discover: `ath --json find "query"` or `ath --json recent --limit 20`
2. Open: `ath --json open <thread-id>`
3. Zoom in: `ath --json open <thread-id>:12 --before 2 --after 3`
4. Export if needed: `ath --json export <thread-id> --format md --out /tmp/thread.md`

Use `--kind message` on `find` when the query is textual:

```bash
ath --json find "retry strategy" --kind message
```

Use full transcripts sparingly:

```bash
ath --json open <thread-id> --format messages --full
```

## Escape Hatches

```bash
ath --json inspect thread <thread-id> --related
ath --json inspect index
ath --json admin sql "select thread_id, count(*) from messages group by 1 order by 2 desc limit 20"
```

Only use read-only `SELECT` or `WITH` SQL.

## Rules

- Prefer `--json`; use `--json-pretty` only for human debugging.
- Prefer `find`/`recent` before `inspect` or `admin sql`.
- Prefer local context `open <thread-id>:<seq>` before full transcripts.
- Do not modify source files with this tool.
- Do not quote long transcript chunks when a short excerpt plus thread id is enough.
