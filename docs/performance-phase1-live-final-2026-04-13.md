# 第一阶段最终实测基准（2026-04-13）

这份文档记录当前第一阶段实现，在完成以下改动之后的 live 基准结果：

- words-first message FTS
- 基于 trusted host manifest 的日志感知 selective sync
- batched message 与 batched FTS insert

原始数据：

- `benchmarks/phase1-targeted-live-final-2026-04-13.json`

## 最终 live targeted 结果

| 场景 | 当前 live 结果 | baseline 中位数 | 相对差异 |
| --- | ---: | ---: | ---: |
| cold `inspect index` | `8.78s` | `3.31s` | 约慢 `2.7x` |
| warm `inspect index` | `0.76s` | `6.61s` | 约快 `8.7x` |
| warm `find "notify_url"` | `0.28s` | `7.19s` | 约快 `25.7x` |
| warm `find "payment"` | `0.28s` | `7.22s` | 约快 `25.9x` |
| `admin reindex` | `9.67s` | `3.51s` | 约慢 `2.8x` |

baseline 参考：

- `docs/performance-baseline-2026-04-13.md`

## 解读

这是第一版在用户可感知的 warm path 上已经明确转成性能正收益的实现。

当前状态是：

- warm `inspect index`：明显获胜
- warm message search：明显获胜
- cold start / 显式 rebuild：仍慢于 baseline，但比第一阶段更早期的运行结果已经实质改善

## 实际结论

当前实现已经在最重要的重复 CLI 使用路径上表现良好：

- 针对已构建索引的重复读取
- 具有代表性的 message search 查询

剩余性能工作，已经被明确收敛到 rebuild 与 cold-start 成本。

## 下一步方向

如果后续 rebuild 或 cold-start 延迟变成新的瓶颈，第一优先应该回到
SQLite FTS5 的批量装载行为，而不是查询路径本身。

建议后续按这个顺序继续调查：

1. 测量当前针对 `messages_fts` 的整表 `INSERT ... SELECT` 回填，是否仍然是最新构建中 cold path 的主要 SQLite 成本。
2. 试验这个 schema 下 SQLite FTS5 的 bulk-load / merge / optimize 行为。
   实际上就是验证：不同的装载模式、segment merge 策略，或显式 optimize 步骤，是否足以改善 rebuild 时间，并值得为此增加复杂度。
3. 把这部分工作严格限定在 rebuild 与 cold-start 路径内。
   当前 warm-read 和 warm-query 路径已经是正收益，不应该为了冷路径实验把它重新搞坏。

保留这份说明，是为了让后续优化能从正确瓶颈开始：
批量 FTS 装载行为，而不是 steady-state 的 words-first 查询路径。
