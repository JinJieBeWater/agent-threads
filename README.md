# ath

`ath` is the only CLI command you need for indexing and querying local agent conversation history.

This repository is still named `agent-threads`, but the user-facing command surface is `ath`.
Today it supports a `codex` source rooted at `~/.codex`.

## Quickstart

Requirements:

- Bun `>= 1.3.0`
- Codex history available at the default source root `~/.codex`

Two common paths:

```bash
bun install
make install-local

ath --json inspect source

# Exact thread id
ath --json inspect thread <thread-id> --related
ath --json open <thread-id>:12 --before 0 --after 0

# Fuzzy topic lookup
ath --json inspect paths --match mercpay
ath --json find "error handling" --repo /path/to/repo
```

By default, `ath` reads Codex history from `~/.codex` and stores its local index under `~/.agent-threads`.

## Skill Layout

This repository also ships a reusable `agent-threads` skill, but it is maintained as a normal repository artifact under `skills/agent-threads`, not under this project's `.codex/skills`.

Use this layout as the source of truth:

```text
skills/
  agent-threads/
    SKILL.md
    agents/openai.yaml
```

Recommended local install:

```bash
make install-skill-local
ls -l ~/.agents/skills/agent-threads
```

Host-specific entrypoints such as `~/.codex/skills` should reference or mirror the global skill source when needed. This repository should not maintain the skill as a project-local `.codex` artifact.

## What It Does

- Builds and incrementally syncs a local SQLite index from session history
- Uses one search entrypoint for both threads and messages
- Uses one open entrypoint for both whole threads and message-local context
- Keeps source and index diagnostics under `inspect`
- Keeps maintenance and advanced escape hatches under `admin`
- Exports one thread as Markdown or JSON

## Command Surface

Exact thread id:

```bash
ath inspect thread <thread-id> --related
ath open <thread-id>:12 --before 0 --after 0
ath open <thread-id>
ath open <thread-id> --format messages --full
ath export <thread-id> --format md --out /tmp/thread.md
```

Scoped discovery:

```bash
ath find "refactor pattern"
ath find "retry strategy" --kind message
ath inspect paths
ath inspect paths --match mercpay
ath inspect paths --repo /path/to/repo
ath find "retry strategy" --repo /path/to/repo
ath find "retry strategy" --worktree /path/to/repo.worktrees/feat-x
ath recent --limit 20
ath recent --repo /path/to/repo
ath recent --since 7d
ath open <thread-id>:12 --before 2 --after 2
```

Diagnostics and maintenance:

```bash
ath --json inspect source
ath inspect index
ath inspect thread <thread-id> --related
ath admin init --source local-codex --source-root ~/.codex
ath admin reindex
ath admin sql "select thread_id, count(*) from messages group by 1 order by 2 desc limit 10"
```

Primary entrypoint:

```bash
ath --help
```

## Sync Model

- Read commands auto-sync the local index before querying.
- Normal sync is incremental at thread granularity: changed session files rebuild only their thread.
- Unchanged source files are a no-op sync.
- `ath admin reindex` remains the explicit full rebuild escape hatch.
- If a session file is mid-write and its trailing JSON line is incomplete, `ath` keeps the existing indexed thread and retries on the next command.

## Recommended Flow

Choose the path that matches the input.

Exact thread id:

1. `inspect thread <thread-id> --related`
2. `open <thread-id>:<seq>` when one message is likely enough
3. `open <thread-id>` only when you need broader thread context

Fuzzy topic or historical decision:

1. `inspect paths`
2. `find` with exactly one of `--repo`, `--worktree`, or `--cwd`
3. `recent` only when you want recency rather than keyword matching
4. `open <thread-id>:<seq>` for local context
5. `open <thread-id>` only when local context is not enough
6. `inspect` and `admin` only for metadata, diagnostics, or maintenance

Do not run `find "<thread-id>"` when the exact id is already known. It searches message text containing the id and may just return the current prompt that mentioned it.

Examples:

```bash
ath --json find "error handling"
ath --json find "retry strategy" --kind message
ath --json inspect paths
ath --json inspect paths --match mercpay
ath --json inspect paths --repo /path/to/repo
ath --json find "retry strategy" --repo /path/to/repo
ath --json find "retry strategy" --worktree /path/to/repo.worktrees/feat-x
ath --json recent --limit 10
ath --json recent --repo /path/to/repo
ath --json recent --since 3d
ath --json open <thread-id>:12 --before 2 --after 3
ath --json open <thread-id> --format messages --full
ath --json inspect index
```

## Scope Filters

Use exactly one of these filters on `find` and `recent`:

- `--cwd /path/to/dir`
  Exact working-directory match only.
- `--worktree /path/to/repo.worktrees/feat-x`
  Matches that worktree root and any nested directory below it.
- `--repo /path/to/repo`
  Matches the main repo root, nested directories below it, and sibling worktrees under `/path/to/repo.worktrees/*`.

Examples:

```bash
ath find "payment" --repo /Users/me/src/mercpay
ath find "payment" --worktree /Users/me/src/mercpay.worktrees/feat-refactor
ath recent --repo /Users/me/src/mercpay --limit 20
```

## Agent Usage

For agent workflows, choose the path that matches the input:

### Exact thread id path

If the user already provides an exact thread id, treat it as a primary key, not a search keyword.

```bash
ath --json inspect thread 019d8985-6fa4-7792-b92c-4fcc008b212f --related
ath --json open 019d8985-6fa4-7792-b92c-4fcc008b212f:11 --before 0 --after 0
```

Only widen if needed:

```bash
ath --json open 019d8985-6fa4-7792-b92c-4fcc008b212f
ath --json open 019d8985-6fa4-7792-b92c-4fcc008b212f --format messages
```

Do not do this:

```bash
ath --json find "019d8985-6fa4-7792-b92c-4fcc008b212f" --kind message
```

That only searches for messages whose text contains the id.

### Scoped discovery path

For fuzzy topic lookup, prefer scope-first history search:

1. Ask `ath` which paths already have conversation history:

```bash
ath --json inspect paths
ath --json inspect paths --match mercpay
ath --json inspect paths --repo /Users/me/src/mercpay
```

2. Prefer the returned `recommended_scope`, `repo_scope`, `worktree_scope`, and `live_status` fields.
3. Infer the likely repo or worktree from those observed paths plus the current task, cwd, mentioned paths, or branch context.
4. If the observed paths are still ambiguous and the current directory is inside a Git repo, resolve the repo and worktrees with Git:

```bash
git rev-parse --show-toplevel
git worktree list --porcelain
```

5. Query `find` or `recent` with exactly one scope flag:
- `--worktree` for one worktree domain
- `--repo` for the main repo plus sibling `.worktrees/*`
- `--cwd` only for exact-directory matching
Those same flags are also accepted by `inspect paths`, but there they only filter returned path rows.
6. Use unscoped `ath find` or `ath recent` only as a fallback when no plausible scope can be inferred.

Notes:

- `inspect paths` is derived from indexed thread history, so it tells you where sessions already exist.
- When a returned path still exists, `inspect paths` also attempts live Git resolution and returns `live_status`, `live_repo_scope`, and `live_worktree_scope`.
- `inspect paths --repo /repo` is a path-row filter, not repo-scoped text search.
- `git worktree list` is authoritative for one repo.
- `~/.codex/worktrees` can provide extra hints about Codex-managed worktrees, but it is not a complete registry of all worktrees on the machine.
- Historical Codex thread metadata in `state_5.sqlite` also includes `cwd`, `git_branch`, and `git_origin_url`, which can help infer relevant repo families, but that is historical data, not a live inventory.

Shortest correct pattern:

```bash
ath --json inspect paths --match mercpay
ath --json find "payment callback" --repo /Users/me/src/mercpay --kind message
```

## Search by Time Range

Use `find` when you want threads or messages that mention a keyword within a specific time window.
Use `recent` when you only want the newest threads, not keyword search.

Examples:

```bash
# One day
ath --json find "xxx" --kind message \
  --since 2026-04-11T00:00:00+08:00 \
  --until 2026-04-11T23:59:59+08:00

# Last 30 days
ath --json find "xxx" --kind message --since 30d

# One calendar month
ath --json find "xxx" --kind message \
  --since 2026-03-01T00:00:00+08:00 \
  --until 2026-03-31T23:59:59+08:00

# Any custom range
ath --json find "xxx" --kind thread \
  --since 2026-01-01T00:00:00Z \
  --until 2026-04-01T00:00:00Z
```

Time filter rules:

- `--since` and `--until` are supported by both `find` and `recent`
- Relative time supports `m`, `h`, `d`, and `w`
- `m` means minutes, not months
- For "one month", prefer `30d` or an explicit absolute range
- Absolute timestamps use anything `Date.parse(...)` can parse reliably; ISO 8601 with timezone is recommended
- Use `--kind message` when the keyword should match message text
- Use `--kind thread` when you want thread-level results
- Omit `--kind` to merge both result types into one ranked list

## Defaults

- Config dir: `~/.agent-threads`
- Config file: `~/.agent-threads/config.json`
- Index DB: `~/.agent-threads/index.sqlite`
- Default source root: `~/.codex`

Config shape:

```json
{
  "defaultSource": "local-codex",
  "indexDb": "~/.agent-threads/index.sqlite",
  "sources": [
    {
      "id": "local-codex",
      "kind": "codex",
      "root": "~/.codex"
    }
  ]
}
```

Resolution order:

1. CLI flags such as `--source`, `--source-root`, and `--index-db`
2. Environment variables `AGENT_THREADS_CONFIG_HOME`, `AGENT_THREADS_INDEX_DB`
3. `~/.agent-threads/config.json`
4. Built-in defaults

## Data Sources

For a `codex` source, the CLI reads:

- `state_5.sqlite`
- `session_index.jsonl`
- `sessions/**/*.jsonl`
- `archived_sessions/**/*.jsonl`

## Install

```bash
cd /path/to/agent-threads
bun install
make install-local
make install-skill-local
command -v ath
ath --json inspect source
```

Naming:

- Repository directory: `agent-threads`
- CLI command: `ath`

## Development Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run check
```

`bun run check` runs typecheck, lint, and tests together.

## Benchmarking

To capture an end-to-end CLI baseline against your current local Codex history:

```bash
make benchmark-baseline
```

This writes a machine-readable snapshot under `benchmarks/` and you can keep a matching human summary under `docs/`.

Two benchmark modes are useful:

- Live source root:
  runs directly against your current `~/.codex`, which reflects real usage but may be noisy if Codex is actively writing logs or session shards while the benchmark is running.
- Static snapshot:
  runs against a copied, frozen snapshot of `~/.codex`, which is better for measuring steady-state performance without source churn.

To create a static source snapshot with a Bun-native helper:

```bash
make make-source-snapshot
```

Or with explicit paths:

```bash
bun scripts/make-source-snapshot.ts \
  --source-root ~/.codex \
  --output-root /tmp/ath-codex-snapshot
```

Then point the benchmark at that snapshot:

```bash
bun scripts/benchmark-baseline.ts \
  --source-root /tmp/ath-codex-snapshot
```

Current performance notes:

- Warm-path performance work now centers on keeping trusted-manifest sync cheap and selective.
- If rebuild or cold-start latency becomes the next bottleneck, start with SQLite FTS5
  bulk-load / merge / optimize experiments before touching the steady-state query path.
- The single authoritative before/after comparison is:
  - `docs/fts-before-after-summary-2026-04-13.md`
- Other `docs/performance-*.md` files are supporting raw records, not the primary conclusion.

## Output Notes

- The tool is read-only.
- Read commands auto-sync source changes before returning results.
- `--refresh` remains accepted for compatibility and still follows the incremental thread-level sync path during normal reads.
- `--json` is compact by default. Use `--json-pretty` only when a human is inspecting raw output.
- `find` returns a unified result stream with `kind`, `target`, and compact snippets.
- `recent` lists threads by newest `updated_at` first and prints one compact summary line per thread.
- `open <thread-id>` returns a thread view; `open <thread-id>:<seq>` returns message-local context.
- `open --format messages` returns a bounded excerpt by default. Add `--full` only when you want the full transcript.
- `admin sql` only allows read-only `SELECT` and `WITH` queries against the generated index.

## Layout

- `src/index.ts`: executable entrypoint
- `src/main.ts`: Effect runtime startup
- `src/cli.ts`: Effect CLI command tree
- `src/handlers.ts`: command behavior and command-surface orchestration
- `src/indexer.ts`: index rebuild and readiness logic
- `src/threads.ts`: thread queries
- `src/messages.ts`: message queries
- `src/request.ts`: read-only SQL guard and execution
- `src/export.ts`: export and raw transcript helpers
- `src/source/codex.ts`: codex source parsing and session reads
- `src/infra/sqlite.ts`: SQLite boundary
- `src/infra/lock.ts`: index lock boundary
- `src/output.ts`: JSON and human output
- `src/render.ts`: human-readable rendering
- `src/errors.ts`: CLI error model
- `test/cli.test.ts`: fixture-backed regression tests
