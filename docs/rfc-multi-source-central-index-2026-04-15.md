# RFC: ath Multi-Source Central Index

Status: Draft

Author: Codex

Date: 2026-04-15

Branch: `ath-multi-source-central-index`

## 1. Summary

This RFC proposes a structural redesign of `ath` from a single-source indexer into a centralized multi-source query engine backed by one shared SQLite database.

The target architecture is:

- one shared `index.sqlite`
- many configured sources
- source-local sync state
- source-aware thread and message identity
- cross-source search by default
- explicit source scoping when needed

The design should maximize SQLite usage instead of pushing source reconciliation and search merging into the application layer.

## 2. Problem

Current `ath` is effectively single-source at runtime even though config already has a `sources[]` shape.

The current design has four hard constraints:

- runtime resolves one active source, not a set of sources
- index usability is bound to one `source_id/source_kind/source_root`
- thread identity is a bare `thread_id`, which collides across sources
- sync metadata is global, so one source can invalidate or overwrite another source's state

As a result:

- `ath` cannot query multiple local histories at once
- one shared index cannot safely hold multiple sources
- adding multi-source support on top of the current schema would produce collisions, invalid incremental-sync decisions, and ambiguous open/export behavior

## 3. Goals

- Store many sources in one shared SQLite index.
- Default `find`, `recent`, and `inspect paths` to cross-source search.
- Allow `--source` to restrict sync and query scope to one source.
- Make thread identity source-aware without losing a user-friendly external thread id.
- Keep incremental sync source-local and cheap.
- Keep SQLite as the primary execution engine for search, ranking inputs, filtering, and aggregation.

## 4. Non-Goals

- Adding non-`codex` source kinds in this RFC.
- Supporting remote/network sources.
- Perfect in-place migration from every old schema variant.
- Preserving every legacy output string exactly when ambiguity now requires stricter behavior.

## 5. Design Principles

1. Source of truth stays in raw source roots such as `~/.codex`.
2. Rebuild must be cheaper than clever schema migration.
3. One source must never corrupt another source's sync state.
4. User-facing ids may stay simple, but storage keys must be unambiguous.
5. SQLite should do the joining, filtering, and FTS work.

## 6. Proposed Runtime Model

### 6.1 Config Resolution

Runtime should resolve:

- one shared `indexDb`
- zero or more configured sources
- one optional selected source from `--source`

Behavior:

- if `--source-root` is passed, run in single-source ad hoc mode
- else if config has `sources[]`, use all enabled sources
- else fall back to one built-in default source rooted at `~/.codex`
- if `--source <id>` is passed, restrict runtime to that source only

### 6.2 Sync Model

Each source is synchronized independently into the shared database.

For each selected source:

1. check whether the source can skip sync
2. if not, try source-local trusted fast path
3. if not, run source-local incremental sync
4. if unusable, run source-local rebuild

Read commands should:

- sync all selected sources before query
- then execute one query against the shared index

`admin reindex` should:

- reindex all selected sources by default
- respect `--source` when present

## 7. Proposed Data Model

The old global `meta/sync_meta` key-value approach is insufficient for multi-source sync state.

The new schema should be relational and source-aware.

### 7.1 Canonical Identity

Use two ids:

- external thread id: the raw thread id from a source
- internal thread identity: unique per source

Recommended model:

- `threads.thread_pk` as internal integer PK
- `UNIQUE(source_id, external_thread_id)`

Messages should belong to `thread_pk`, not to a bare external thread id.

### 7.2 Tables

#### `sources`

Purpose:

- registry of configured sources inside the index

Schema:

```sql
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  root TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Notes:

- `root` is informational and diagnostic, not the only runtime source of config truth
- `enabled` lets us soft-disable a source without dropping its rows immediately

#### `source_sync_state`

Purpose:

- source-local incremental sync state

Schema:

```sql
CREATE TABLE source_sync_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_root TEXT NOT NULL,
  built_at TEXT,
  last_sync_at TEXT NOT NULL DEFAULT '',
  last_state_db_mtime_ms INTEGER NOT NULL DEFAULT 0,
  last_source_fingerprint TEXT NOT NULL DEFAULT '',
  last_source_directory_manifest TEXT NOT NULL DEFAULT '',
  last_logs_high_water INTEGER NOT NULL DEFAULT 0,
  active_session_file_count INTEGER NOT NULL DEFAULT 0,
  archived_session_file_count INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL
);
```

Notes:

- this replaces source-specific use of global `sync_meta`
- all skip/incremental/trusted checks should read from here

#### `threads`

Purpose:

- source-aware thread metadata and precomputed counters

Schema:

```sql
CREATE TABLE threads (
  thread_pk INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  external_thread_id TEXT NOT NULL,
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
  last_message_at TEXT,
  UNIQUE (source_id, external_thread_id)
);
```

Indexes:

```sql
CREATE INDEX idx_threads_source_external ON threads(source_id, external_thread_id);
CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC);
CREATE INDEX idx_threads_provider ON threads(model_provider);
CREATE INDEX idx_threads_cwd ON threads(cwd);
```

#### `messages`

Purpose:

- normalized message storage keyed by internal thread PK

Schema:

```sql
CREATE TABLE messages (
  message_pk INTEGER PRIMARY KEY,
  thread_pk INTEGER NOT NULL REFERENCES threads(thread_pk) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message_ref TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT,
  text TEXT NOT NULL,
  created_at TEXT,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  UNIQUE (thread_pk, seq)
);
```

Indexes:

```sql
CREATE INDEX idx_messages_thread_seq ON messages(thread_pk, seq);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_created_at ON messages(created_at);
```

#### `messages_fts`

Purpose:

- FTS5 search over message text

Schema:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'message_pk',
  tokenize = "unicode61 remove_diacritics 0 tokenchars '-_./:#'"
);
```

Notes:

- prefer external-content mode over contentless mode for easier consistency and debugging
- rebuild path can bulk-load or `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`

#### `thread_sources`

Purpose:

- source-local tracking of transcript files used to build a thread

Schema:

```sql
CREATE TABLE thread_sources (
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  current_path TEXT NOT NULL,
  thread_pk INTEGER NOT NULL REFERENCES threads(thread_pk) ON DELETE CASCADE,
  archived INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_since TEXT,
  last_state_updated_at INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL,
  PRIMARY KEY (source_id, current_path)
);
```

Indexes:

```sql
CREATE INDEX idx_thread_sources_thread_pk ON thread_sources(thread_pk);
CREATE INDEX idx_thread_sources_source_path ON thread_sources(source_id, current_path);
```

### 7.3 Optional Compatibility Views

To reduce churn in diagnostics and local SQL habits, we may optionally expose read-only views:

- `threads_legacy`
- `messages_legacy`

These are not required for the first delivery and should not block the redesign.

## 8. Query Semantics

### 8.1 Default Behavior

Default scope for read commands:

- all selected sources in runtime

Commands affected:

- `find`
- `recent`
- `inspect paths`

### 8.2 Source Filter

`--source <id>` should:

- restrict sync to that source
- restrict queries to that source
- make bare external thread ids unambiguous within that source

### 8.3 Thread Open Semantics

`open`, `inspect thread`, and `export` require a deterministic thread lookup.

Accepted forms:

- `<thread-id>`
- `<source-id>/<thread-id>`
- `thread:<thread-id>`
- `thread:<source-id>/<thread-id>`
- `<source-id>/<thread-id>:<seq>`

Lookup rules:

1. if source is explicit, resolve by `(source_id, external_thread_id)`
2. else resolve by external id within currently selected runtime sources
3. if zero matches, return `thread-not-found`
4. if one match, open it
5. if multiple matches, return `ambiguous-thread-id` and list candidate `source_id`s

### 8.4 Result Shape

Cross-source query results should include:

- `source_id`
- `thread_id` as external thread id
- `target`

Target format:

- single-source runtime: preserve legacy-friendly `thread:<thread-id>`
- multi-source runtime without `--source`: use `thread:<source-id>/<thread-id>`

This preserves old ergonomics where ambiguity cannot exist and becomes explicit where ambiguity is possible.

## 9. Command Compatibility Strategy

### 9.1 Keep Stable

Keep command names and broad intent stable:

- `find`
- `recent`
- `open`
- `inspect source`
- `inspect index`
- `inspect thread`
- `inspect paths`
- `export`
- `admin init`
- `admin reindex`
- `admin sql`

### 9.2 Compatibility Rules

#### `find`

- no breaking CLI flag changes
- add `source_id` to JSON result rows
- default to cross-source query

#### `recent`

- no breaking CLI flag changes
- add `source_id` to JSON result rows
- keep legacy target format when one source is in play

#### `open`

- continue accepting bare thread ids
- add explicit `<source>/<thread-id>` form
- on ambiguity, fail loudly instead of picking arbitrarily

#### `inspect thread`

- same resolution rules as `open`

#### `export`

- same resolution rules as `open`

#### `inspect source`

This command needs a compatibility decision.

Recommended behavior:

- if one source is selected, show existing single-source payload
- if multiple sources are selected, return:
  - shared `indexDb`
  - source list
  - source-local existence checks
  - selected-source info if `--source` is present

#### `admin init`

Recommended behavior:

- preserve current ability to set one source
- if the source id already exists, update it
- if the source id does not exist, append it
- add a future `--disable-other-sources` only if needed later

#### `admin reindex`

Recommended behavior:

- no `--source`: rebuild all selected sources
- `--source`: rebuild only that source
- single-source runtime: return legacy single-object shape
- multi-source runtime: return array of per-source rebuild stats

## 10. Migration Strategy

### 10.1 Recommendation

Do not implement a complicated in-place schema migration.

Preferred migration:

1. introduce a new schema version and new central index format
2. when the existing DB is legacy or incompatible, rebuild from source-of-truth
3. optionally use a new filename such as `index.v2.sqlite` during rollout

Rationale:

- raw source data already exists
- rebuild is deterministic
- in-place migration must reason about old partial indexes, partial sync state, old FTS modes, and broken intermediate schemas
- rebuild is cheaper than carrying permanent schema-compatibility debt

### 10.2 Migration Phases

#### Phase A: New Schema Behind Rebuild

- create new central schema
- detect old schema
- rebuild from configured sources

#### Phase B: Read Path Switch

- switch all read commands to central schema
- preserve single-source UX where possible

#### Phase C: Legacy Cleanup

- remove old global source-bound index assumptions
- remove dead compatibility branches

### 10.3 Legacy Detection

Treat the DB as legacy if any of these are true:

- `threads` lacks `thread_pk`
- `threads` lacks `source_id`
- `threads` lacks `external_thread_id`
- `thread_sources` lacks `thread_pk`
- `source_sync_state` is missing
- `messages` is keyed by external thread id instead of `thread_pk`

### 10.4 Rebuild Semantics

Source-local rebuild should:

- delete rows belonging only to the target source
- not wipe unrelated source rows
- rebuild `threads`, `messages`, `messages_fts`, `thread_sources`, and `source_sync_state` for that source

## 11. SQLite Utilization Strategy

### 11.1 What SQLite Should Own

SQLite should own:

- source-scoped filtering
- path/cwd aggregation
- thread/message joins
- FTS search
- per-thread counters
- uniqueness constraints
- source-local sync-state persistence

### 11.2 What Application Code Should Own

Application code should own:

- source parsing from raw files
- thread-title and message normalization heuristics
- source iteration order
- ambiguity policy for user-facing commands

### 11.3 FTS Notes

Recommended direction:

- keep FTS5
- keep current tokenchars tuning
- use external-content mode
- retain fallback contains search for short/special-token miss cases

Potential follow-up work after correctness:

- `optimize` after rebuild
- source-aware ranking hints
- materialized metadata features for better ranking

## 12. Sync Algorithm Notes

### 12.1 Trusted Fast Path

Trusted fast path should be source-local:

- compare source-local fingerprint
- compare source-local state DB mtime
- compare source-local logs high-water mark
- refresh only active threads for that source

### 12.2 Incremental Path

Incremental path should:

- read source-local tracked files
- compute source-local rebuild plan
- rebuild only affected threads for that source
- mark missing files only inside that source

### 12.3 Thread Source Tracking

`thread_sources` should resolve one source file to one source-local thread only.

The current path-based uniqueness model becomes correct once `(source_id, current_path)` is the PK.

## 13. Testing Checklist

### 13.1 Schema and Identity

- one shared index can hold two sources at once
- same `external_thread_id` from two sources does not collide
- same `source_file` basename from two sources does not collide
- `thread_sources` path tracking is isolated by source

### 13.2 Sync

- cross-source warm read syncs all selected sources
- `--source alpha` syncs only alpha
- source A rebuild does not delete source B rows
- source-local trusted fast path does not consume source B logs state
- source-local incremental sync updates only affected source rows

### 13.3 Query

- `find` returns hits from multiple sources by default
- `find --source` filters correctly
- `recent` merges multiple sources in updated-at order
- `inspect paths` aggregates path rows across multiple sources
- `inspect paths --source` filters correctly if supported

### 13.4 Open / Inspect / Export

- bare thread id resolves when unique across selected sources
- bare thread id fails with `ambiguous-thread-id` when duplicated
- explicit `source/thread` resolves correctly
- explicit `source/thread:seq` opens correct message context
- export works for explicit and unique bare ids

### 13.5 Compatibility

- single-source runtime still emits legacy-style targets
- legacy second-based indexes trigger rebuild into the new schema
- existing `admin sql` remains read-only and works on new tables

### 13.6 Failure and Recovery

- unstable trailing JSON in one source does not corrupt another source
- missing file handling is source-local
- read-only fallback temp index still works with multiple configured sources

## 14. Rollout Plan

### Phase 1: RFC and Acceptance Tests

- finalize this RFC
- add failing tests for:
  - shared-index multi-source search
  - duplicate external thread ids across sources
  - source-aware open ambiguity

### Phase 2: Storage Layer

- implement new schema
- implement source registry and source sync state
- change thread/message ownership model

### Phase 3: Sync Layer

- update rebuild
- update incremental sync
- update trusted fast path

### Phase 4: Query Layer

- update `find`
- update `recent`
- update `inspect paths`
- update `open`, `inspect thread`, and `export`

### Phase 5: Diagnostics and Docs

- update `inspect source`
- update README examples
- document new explicit source-qualified thread syntax

## 15. Risks

- ambiguity behavior for `open` may surface previously hidden collisions
- source-local rebuild on a shared DB increases the need for careful transactional boundaries
- `inspect source` payload shape may need a versioned or compatibility-conscious expansion
- old direct test helpers and internal tooling that assume bare `thread_id` is the storage PK will break

## 16. Open Questions

1. Should `inspect paths` always include `source_ids`, or only when more than one source is configured?
2. Should `admin init` append sources by default forever, or should we add an explicit replace mode?
3. Should we introduce a top-level `ath sources` command for visibility and enable/disable control?
4. Should we use a new filename such as `index.v2.sqlite` during rollout, or keep `index.sqlite` and rebuild in place?

## 17. Recommendation

Proceed with a new central schema and rebuild-first migration.

Do not try to retrofit multi-source behavior into the current single-source storage model. The right cut is:

- source-local sync state
- source-aware storage keys
- shared relational index
- explicit ambiguity handling at command edges

That gives `ath` a clean foundation for multi-source local history search without carrying forward single-source assumptions into every future change.
