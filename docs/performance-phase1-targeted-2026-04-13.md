# 第一阶段定向基准（2026-04-13）

这份文档记录当前第一阶段 words-first FTS 版本在实现落地后的定向 benchmark。

原始机器可读数据保存在：

- `benchmarks/phase1-targeted-2026-04-13.json`

## 目的

这轮运行想回答的问题很简单：

- 在第一阶段重构之后，当前实现是否已经在端到端 CLI 延迟上，实质性超过 trigram 改造前的 baseline？

在当时记录这份结果时，答案仍然是否定的。

## 方法

这些命令以串行方式对 `~/.codex` 运行：先使用一份全新临时索引，再在后续 warm read 中复用同一份临时索引。

测量命令集：

1. cold `inspect index`
2. warm `inspect index`
3. warm `find "notify_url" --kind message --limit 20`
4. warm `find "payment" --kind message --limit 20`
5. `admin reindex`

这是一轮干净的串行运行。
在它之前，曾经有过一轮针对同一份临时索引的并行尝试，但由于 SQLite 锁竞争使结果无效，后来被丢弃。

## 结果

| 场景 | 当前第一阶段结果 | baseline 中位数 | 相对差异 |
| --- | ---: | ---: | ---: |
| cold `inspect index` | `15.43s` | `3.31s` | 约慢 `4.7x` |
| warm `inspect index` | `84.29s` | `6.61s` | 约慢 `12.8x` |
| warm `find "notify_url"` | `107.17s` | `7.19s` | 约慢 `14.9x` |
| warm `find "payment"` | `97.74s` | `7.22s` | 约慢 `13.5x` |
| `admin reindex` | `28.01s` | `3.51s` | 约慢 `8.0x` |

baseline 参考：

- [performance-baseline-2026-04-13.md](/Users/jinjiebewater/my/personal/projects/vibe/agent-threads-trigram-index/docs/performance-baseline-2026-04-13.md)

## 解释

这比更早那次灾难级的 trigram smoke check 好一些，但仍然不能算性能正收益。

已经改善的部分：

- 系统现在在功能上是正确的
- fast path 的语义更干净，也更站得住脚
- 搜索架构更接近预期的最终形态

仍然没有改善到位的部分：

- warm read 延迟仍远高于 trigram 改造前的 baseline
- warm message search 仍远没到目标区间
- full rebuild 和显式 reindex 仍明显比之前更重

## 当前理解

当前第一阶段实现，更应该被理解为一次架构纠偏，而不是一次性能胜利。

它看起来已经解决了一些很重要的正确性与设计问题：

- trusted-manifest 与 synthetic-source 行为已经被显式分离
- words-first FTS 已经成为主 message-search 路径
- fallback 行为已经被收紧

但 benchmark 证据仍然表明，端到端成本还是太高。

## 下一步

下一轮性能工作，应该先证明剩余端到端成本到底落在哪一层。

最值得优先测量的目标包括：

- warm `ensureIndex()` 现在还有多少时间花在打开与校验索引上
- 当前 `inspect index` 路径里，有多少 SQLite 成本其实和 sync 无关
- message FTS lookup 是否仍然主要被 join / rank / snippet 开销主导
- trusted-manifest fast path 是否还能继续降成本，同时不重新引入 stale read 风险

## 结论

第一阶段是一次正确性与架构层面的改善。
它当时还不是 benchmark 层面的胜利。
