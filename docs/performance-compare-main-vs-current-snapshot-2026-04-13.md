# Main vs Current Snapshot Benchmark (2026-04-13)

This document compares `main` and the current `wip-ath-trigram-index` branch against the
same static source snapshot:

- `/tmp/ath-codex-snapshot-1776076381`

Each case was run with one cold sample and one warm sample, using the same command set.

Raw data:

- `benchmarks/compare-main-vs-current-snapshot-2026-04-13.json`

## Results

| Case | `main` | `wip-ath-trigram-index` | Reading |
| --- | ---: | ---: | --- |
| cold `inspect index` | `6.10s` | `6.67s` | current is about `9%` slower |
| warm `inspect index` | `6.89s` | `1.20s` | current is about `5.8x` faster |
| warm `recent --limit 20` | `6.86s` | `0.24s` | current is about `28x` faster |
| warm `find "notify_url"` | `9.97s` | `0.29s` | current is about `34x` faster |
| warm `find "payment"` | `9.80s` | `0.30s` | current is about `33x` faster |
| warm `find "epay callback"` | `7.19s` | `0.30s` | current is about `24x` faster |
| `admin reindex` | `5.60s` | `11.96s` | current is about `2.1x` slower |

## Interpretation

Compared to `main`, the current branch is:

- materially better on every warm read path
- materially worse on explicit rebuild / cold rebuild path
- roughly flat to slightly worse on cold `inspect index`

This lines up with the rest of the profiling work in this branch:

- the FTS + selective sync path wins hard in steady-state / repeated reads
- rebuild and cold-start cost remain the main tradeoff

## Practical verdict

If the primary use case is repeated local search and inspection against an already-built
index, the current branch is decisively better than `main`.

If cold build and explicit `admin reindex` latency matter more than warm repeated reads,
`main` still has the edge.
