# 第一阶段快照基准（2026-04-13）

这份文档记录同一版第一阶段实现，在 `~/.codex` 的一份静态快照上跑出来的结果。
这份快照被复制到 `/tmp`，确保测量过程中 source root 保持静止。

原始数据：

- `benchmarks/phase1-profile-snapshot-2026-04-13.json`
- `benchmarks/phase1-targeted-snapshot-2026-04-13.json`

## 为什么这轮很重要

之前针对 live `~/.codex` 的 benchmark 与 profile，主要被一个持续变化的活跃 session 主导。
这会不断打穿 warm-read sync gate，让实现看起来比 steady-state 慢得多。

为了拆开下面两类成本：

- steady-state 成本
- live active-session 失效成本

source root 被快照到 `/tmp`，并在那份快照上重新做 benchmark。

## 快照定向结果

| 场景 | 第一阶段在静态快照上的结果 |
| --- | ---: |
| cold `inspect index` | `31.22s` |
| warm `inspect index` | `0.60s` |
| warm `find "notify_url"` | `0.34s` |
| warm `find "payment"` | `0.35s` |
| `admin reindex` | `14.21s` |

## 快照 profile 关键数字

| 操作 | 耗时 |
| --- | ---: |
| `rebuildIndexUnlocked` | `30.85s` |
| `canSkipIncrementalSync` | `90.69ms` |
| `ensureIndex` | `17.49ms` |
| `getThreadStats` | `4.89ms` |
| `searchMessages("notify_url")` | `34.00ms` |
| `searchMessages("payment")` | `16.26ms` |

## 解读

这显著改变了前一轮 live benchmark 的解释方式：

1. 在 steady state 下，当前第一阶段实现其实已经能把 warm read 做快。
   - warm `inspect index` 已经低于 `1s`
   - warm message search 也明显低于 `1s`

2. 剩余的大回归，主要集中在 rebuild / cold-start 成本。
   - cold `inspect index` 和显式 `admin reindex` 仍然明显慢于 baseline

3. 先前 live 运行中的减速，主要是 source activity 问题。
   - 活跃的 `logs_2.sqlite` / 活跃 session shard 更新，会不断打穿 warm gate
   - 放到静态快照上之后，同一套代码路径里的 `ensureIndex` 会降到毫秒级

## 当前实际结论

当前第一阶段实现的状态是：

- 还不是 cold-start / rebuild 的胜利
- 但在 source root 保持静止时，已经是很强的 steady-state warm-read 胜利

这意味着下一轮优化目标，比之前已经收窄很多：

- 降 rebuild 成本
- 或者把 live active-session 的失效影响，与无关的 warm read 更好地隔离开

现在已经不太像是 words-first FTS 查询路径本身有问题了。
