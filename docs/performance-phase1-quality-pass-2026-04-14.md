# Phase 1 Benchmark After Result-Quality Pass (2026-04-14)

This document records a fresh benchmark after the message-result quality pass that added:

- same-thread message dedupe
- title / first-user-message ranking boosts
- broad natural-language meta-discussion downranking

Raw data:

- `benchmarks/phase1-quality-pass-2026-04-14.json`

Measured against the static snapshot:

- `/tmp/ath-codex-snapshot-1776076381`

## Results

| Case | Current result |
| --- | ---: |
| cold `inspect index` | `5.93s` |
| warm `inspect index` | `1.12s` |
| warm `recent --limit 20` | `0.22s` |
| warm `find "notify_url"` | `0.42s` |
| warm `find "payment"` | `0.39s` |
| warm `find "epay callback"` | `0.28s` |
| `admin reindex` | `7.89s` |

## Reading

The result-quality pass did not break the warm-path performance gains.

The current implementation still keeps:

- warm read paths in the sub-second to low-second range
- representative warm message search queries in the sub-second range

The remaining cost concentration is still on cold-start and explicit rebuild, not on
the message-ranking refinements added in this pass.

## Practical verdict

At this point the branch has both:

- a strong warm-path performance story
- a meaningfully better message result-quality story

Cold path remains the main tradeoff.
