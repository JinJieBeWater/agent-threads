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

1. Scope first: determine which repo or worktree the user question belongs to before querying history.
2. Inspect observed session paths: `ath --json inspect paths`
3. Discover: use scoped `ath --json find ...` or `ath --json recent ...`
4. Open: `ath --json open <thread-id>`
5. Zoom in: `ath --json open <thread-id>:12 --before 2 --after 3`
6. Export if needed: `ath --json export <thread-id> --format md --out /tmp/thread.md`

### Scope First

Prefer narrowing the search before calling `ath`.

Typical order:

1. Infer the likely repo/worktree from the current task, current cwd, user wording, branch name, or file paths already in context.
2. Ask `ath` which paths already have history:

```bash
ath --json inspect paths
ath --json inspect paths --match mercpay
```

3. Prefer the returned `recommended_scope`, `repo_scope`, `worktree_scope`, and `live_status` fields.
4. If the current directory is inside a Git repo and the `inspect paths` result is still ambiguous, use Git to resolve scope:

```bash
git rev-parse --show-toplevel
git worktree list --porcelain
```

5. Pick exactly one scope:
- `--worktree /path/to/repo.worktrees/feat-x` for branch- or worktree-specific questions.
- `--repo /path/to/repo` for whole-project history across the main repo and its sibling `.worktrees/*`.
- `--cwd /path/to/dir` only when the question is truly about one exact working directory.
6. Only fall back to broad unscoped `ath find` or `ath recent` when you cannot infer a plausible scope.

Examples:

```bash
ath --json inspect paths --match mercpay
ath --json find "retry strategy" --repo /Users/me/src/mercpay
ath --json find "payment callback" --worktree /Users/me/src/mercpay.worktrees/feat-refactor
ath --json recent --repo /Users/me/src/mercpay --limit 20
```

If the current repo is unclear but Codex-managed worktrees may be relevant, inspecting `~/.codex/worktrees` can provide additional hints. Treat that as a convenience source, not a canonical global registry.

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
- Prefer `inspect paths` before project-scoped history search.
- Prefer repo/worktree-scoped queries over global queries.
- Determine the most likely repo/worktree before calling `ath` when the user question is project-specific.
- Prefer `find`/`recent` before `inspect` or `admin sql`.
- Prefer local context `open <thread-id>:<seq>` before full transcripts.
- Do not modify source files with this tool.
- Do not quote long transcript chunks when a short excerpt plus thread id is enough.
