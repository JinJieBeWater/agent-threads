# 第一阶段性能剖析记录（2026-04-13）

这份文档记录当前第一阶段 words-first FTS 实现的第一轮函数级 profiling。

原始机器可读数据保存在：

- `benchmarks/phase1-profile-2026-04-13.json`

使用的 profiling 辅助脚本是：

- `scripts/profile-phase1.ts`

## 为什么要跑这次

定向 benchmark 已经表明，当前第一阶段实现仍然明显慢于 trigram 改造前的 baseline。

剩下的问题是：

- 成本到底还在真正的 query / stats SQL 上，还是仍然主要被 sync preflight 路径支配？

## 关键结论

瓶颈几乎完全在 `ensureIndex()`，而不在核心的 `inspect` 或 message-search SQL 本身。

## 函数级耗时

基于从 `~/.codex` 构建的一份全新临时索引测得：

| 操作 | 耗时 |
| --- | ---: |
| `rebuildIndexUnlocked` | `11.92s` |
| `canSkipIncrementalSync` | `14.64ms` |
| `ensureIndex` | `51.36s` |
| `getThreadStats` | `25.60ms` |
| `searchMessages("notify_url")` | `71.09ms` |
| `searchMessages("payment")` | `33.23ms` |

## `inspect index` 背后原始 SQL 的耗时

`getThreadStats()` 背后的各条 SQL 都非常小：

| 查询 | 耗时 |
| --- | ---: |
| 检查 `sqlite_master` 中是否存在 `messages` | `0.15ms` |
| 从 `threads` 读取总数 | `3.00ms` |
| `COUNT(*) FROM messages` | `0.35ms` |
| provider 聚合 | `0.07ms` |
| top cwd 聚合 | `0.11ms` |
| 读取 meta | `0.02ms` |

这基本排除了 CLI benchmark 中观察到的 `80s` 到 `100s` 端到端延迟，是由 `inspect index` SQL 本身造成的可能。

## 这轮 profile 说明了什么

1. words-first FTS 查询路径不是主成本。
   直接调用 `searchMessages(...)` 的耗时只有几十毫秒量级。

2. `getThreadStats()` 也不是主成本。
   直接函数调用本身，以及它背后的原始 SQL，都很便宜。

3. 剩余成本在 `ensureIndex()`。
   这轮里它花了大约 `51s`，相比真正的 stats query 和 message search，高出了几个数量级。

## 重要补充观察

这轮 profile 还记录到：trusted-manifest fingerprint 在运行过程中发生了变化，尽管 `state_5.sqlite` 和 `session_index.jsonl` 都没有变化：

- `sourceFingerprintBefore` 和 `sourceFingerprintAfter` 的差异，仅来自 `logs_2.sqlite` 的 size 与 mtime 变化
- `session_index.jsonl` 保持不变

这说明当前 trusted fast path 仍然会被 `logs_2.sqlite` 的活动打穿。

结合这轮会话中的本地观察：

- 活跃 session shard 文件的 mtime 一直在前进
- `logs_2.sqlite` 一直在前进
- `session_index.jsonl` 基本已经失去时效

当前的 trusted-manifest fast path 在繁忙的 live 环境里仍然太嘈杂，无法稳定产出真正的 warm no-op。

## 实际理解

到这个阶段，当前实现更准确的理解应该是：

- query path：大体修好了
- stats query path：大体修好了
- sync fast path：仍然是真正的问题

## 下一轮工程方向

下一轮优化应该集中在：用更便宜但更有选择性的 host activity 检查，替换当前 trusted-manifest 逻辑。例如：

- 把 `logs_2.sqlite` 当作最近活跃 `thread_id` 的来源，而不是粗暴的 size / mtime 指纹
- 只对最近活跃线程的 rollout path 做 `stat`，而不是只要日志增长就整体失效
- 对 synthetic 或 partial source，保留现有的保守 fallback 路径

## 结论

这轮 profile 已确认，当前剩余的性能问题几乎全部集中在 warm-read sync gating，而不是新的 words-first FTS SQL 本身。
