# agent-threads

`agent-threads` is a local, read-only CLI for indexing and querying agent conversation history.

Today it supports a `codex` source rooted at `~/.codex`. The shape is intentionally source-based so it can grow into a broader cross-agent history tool without renaming the project again.

## What It Does

- Builds a local SQLite index from session history
- Searches threads by title, first user message, and message hits
- Searches messages by text and returns snippets by default
- Reads exact local context around one message
- Opens one thread as a bounded excerpt by default, or as a full transcript with `--full`
- Exports one thread as Markdown or JSON

## Command Surface

```bash
agent-threads --json doctor
agent-threads init --source local-codex --source-root ~/.codex
agent-threads index rebuild

agent-threads threads list --limit 20
agent-threads threads search "refactor pattern"
agent-threads threads get <thread-id>
agent-threads threads open <thread-id> --format messages
agent-threads threads open <thread-id> --format messages --full
agent-threads threads related <thread-id>
agent-threads threads stats

agent-threads messages search "retry strategy"
agent-threads messages context <thread-id> --message <message-seq> --before 2 --after 2

agent-threads export thread <thread-id> --format md --out /tmp/thread.md
agent-threads request sql "select thread_id, count(*) from messages group by 1 order by 2 desc limit 10"
```

Short alias:

```bash
ath threads search "error handling"
```

## Recommended Flow

Use this order unless you already know the exact thread:

1. `threads search`
2. `messages search` if the query is more textual than topical
3. `messages context` once you know the thread and anchor
4. `threads open --format messages --full` only when you truly want the whole transcript

Examples:

```bash
agent-threads --json threads search "error handling"
agent-threads --json messages search "retry strategy"
agent-threads --json messages context <thread-id> --message 12 --before 2 --after 3
agent-threads --json threads open <thread-id> --format messages --full
```

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
make install-local
command -v agent-threads
command -v ath
agent-threads --json doctor
```

## Output Notes

- The tool is read-only.
- `--json` is compact by default. Use `--json-pretty` only when a human is inspecting raw output.
- `threads list`, `threads search`, and `messages search` return compact agent-first shapes.
- `messages search` returns snippets, not full message bodies.
- `threads open --format messages` returns a bounded excerpt by default. Add `--full` only when you want the full transcript.
- `request sql` only allows read-only `SELECT` and `WITH` queries against the generated index.

## Layout

- `src/index.ts`: CLI registration
- `src/handlers.ts`: command behavior
- `src/store.ts`: indexing and query logic
- `src/output.ts`: JSON and human output
- `src/render.ts`: human-readable rendering
- `src/errors.ts`: CLI error model
- `test/cli.test.ts`: fixture-backed regression tests
