# FTS 复盘索引（2026-04-13）

这份文档是本次第一阶段 FTS / trigram 调研与重写的总索引。
它的目的，是让以后回顾时可以先从一张稳定地图开始，而不是重新翻完整个线程历史。

## 建议阅读顺序

推荐按这个顺序阅读：

1. `docs/fts-retrospective-2026-04-13.md`
2. `docs/fts-retrospective-benchmarking-2026-04-13.md`
3. `docs/fts-retrospective-sync-2026-04-13.md`
4. `docs/fts-retrospective-search-2026-04-13.md`

## 当前稳定结论

基于这个工作树中的第一阶段最终状态，目前可以稳定确认：

- warm read 性能已经是真正的正收益
- warm message search 性能已经是真正的正收益
- cold start 和显式 rebuild 仍然比原始 baseline 慢
- 最终的 words-first FTS 查询路径已经不是当前主要瓶颈
- 这轮排障的主线，主要集中在 sync gate、source 可变性，以及写放大问题

## 文档拆分说明

### 1. 性能测量类踩坑

- `docs/fts-retrospective-benchmarking-2026-04-13.md`

这部分覆盖：

- 哪些 benchmark 结果可信
- 哪些结果带有误导性
- 为什么 live `~/.codex` 与静态 snapshot 会讲出不同的故事
- 回看性能结论时，应该优先信哪些产物

### 2. 同步路径踩坑

- `docs/fts-retrospective-sync-2026-04-13.md`

这部分覆盖：

- bookkeeping 层面的 bug
- stale read 相关 bug
- trusted manifest fast path 的错误设计
- 为什么最后必须引入 active-thread selective sync

### 3. 搜索 / 表结构 / 写入路径踩坑

- `docs/fts-retrospective-search-2026-04-13.md`

这部分覆盖：

- 为什么 standalone trigram 最终输了
- 为什么 words-first FTS 成了主路径
- 为什么 fallback 必须限制 query shape
- 为什么 batched insert 会影响 cold / reindex 成本

## 产物时间线

### 实现前

- `benchmarks/baseline-2026-04-13.json`
- `docs/performance-baseline-2026-04-13.md`

### 第一次失败的 trigram 实验

- `benchmarks/trigram-smoke-2026-04-13.json`
- `docs/performance-trigram-smoke-2026-04-13.md`

### 第一阶段早期，仍然明显落后

- `benchmarks/phase1-targeted-2026-04-13.json`
- `docs/performance-phase1-targeted-2026-04-13.md`
- `benchmarks/phase1-profile-2026-04-13.json`
- `docs/performance-phase1-profile-2026-04-13.md`

### 证明 steady state 下 warm path 其实已经变好的 snapshot 运行

- `benchmarks/phase1-profile-snapshot-2026-04-13.json`
- `benchmarks/phase1-targeted-snapshot-2026-04-13.json`
- `docs/performance-phase1-snapshot-2026-04-13.md`

### selective sync 和 batched insert 之后

- `benchmarks/phase1-targeted-live-post-selective-2026-04-13.json`
- `docs/performance-phase1-live-post-selective-2026-04-13.md`
- `benchmarks/phase1-targeted-live-final-2026-04-13.json`
- `docs/performance-phase1-live-final-2026-04-13.md`

## 最终状态摘要

这个工作树里最终沉淀下来的实现形态是：

- words-first message FTS
- 限制 query shape 的 contains fallback
- 将 trusted-host fast path 与 synthetic / partial source 行为分离
- 感知日志活动的 active-thread selective sync
- batched message 与 batched FTS insert

## 下次继续时优先复查什么

如果后面还要继续这条线，建议先检查这三件事：

1. cold `inspect index` 和 `admin reindex` 是否仍然明显慢于 baseline
2. 当前 `~/.codex` 的行为下，`logs_2.sqlite` 是否仍然是最合适的 active-thread 信号
3. active 的多分片线程是否依旧主导 selective sync 成本
