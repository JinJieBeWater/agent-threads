# FTS 复盘：性能测量踩坑（2026-04-13）

这份文档记录了 FTS 重写过程中，和性能测量有关的几个主要陷阱。

## 坑 1：如果一开始没有固定 baseline，后面的所有性能结论都会发虚

### 症状

很容易说出“感觉变慢了”，但说不清到底慢了多少、慢在哪些命令上、以及是在哪种数据形态下变慢。

### 如何修正

我们先记录了一份 FTS 改造前的 baseline：

- `benchmarks/baseline-2026-04-13.json`
- `docs/performance-baseline-2026-04-13.md`

### 稳定经验

任何 search-path 改造，都不要在没有 baseline 的前提下开始。
baseline 至少要同时覆盖 cold read 和 warm read 命令。

## 坑 2：第一次 trigram smoke check 差到应该被当作事故记录，而不是“正常的改后数据”

### 症状

第一版 standalone trigram 原型，端到端耗时表现是灾难级的。

### 记录

- `benchmarks/trigram-smoke-2026-04-13.json`
- `docs/performance-trigram-smoke-2026-04-13.md`

### 稳定经验

如果一个 prototype 明显是坏的，记录要保留，但要明确把它标成历史事故，不要把它当正常对比点。

## 坑 3：对同一个临时 SQLite 索引并行跑 benchmark，本身就是无效测量

### 症状

多个并行 benchmark 复用同一个临时索引时，会触发 `database is locked`，最后得到的数字没有可用性。

### 影响

这直接废掉了一次 targeted run，也让后面的 benchmark 必须改成严格串行执行。

### 稳定经验

只要 benchmark 会复用同一个 SQLite 索引文件，就必须串行跑。
唯一的例外，是你明确就是要测锁竞争。

## 坑 4：直接对 live `~/.codex` 做 benchmark，会严重夸大 warm read 成本

### 症状

基于 live `~/.codex` 的测量结果，比 snapshot 测量差得多。

### 原因

benchmark 运行时，source root 本身就在持续变化：

- `logs_2.sqlite` 一直在增长
- 当前活跃 session shard 文件一直在变化
- `session_index.jsonl` 基本不变

### 记录

- `benchmarks/phase1-profile-2026-04-13.json`
- `docs/performance-phase1-profile-2026-04-13.md`
- `benchmarks/phase1-profile-snapshot-2026-04-13.json`
- `benchmarks/phase1-targeted-snapshot-2026-04-13.json`
- `docs/performance-phase1-snapshot-2026-04-13.md`

### 稳定经验

只要 source root 是 live 且会变动，就一定要补一组静态 snapshot benchmark 作为对照。

## 坑 5：CLI 黑盒计时会让人误以为 FTS SQL 很慢，但真正昂贵的是 sync gate

### 症状

端到端的 `inspect index` 和 `find --kind message` 都很慢，所以第一直觉很容易把锅甩给查询层。

### profiling 后看到的事实

函数级 profiling 结果表明：

- `ensureIndex()` 才是真正的成本中心
- `getThreadStats()` 很便宜
- `searchMessages(...)` 很便宜
- 原始 inspect SQL 基本都在毫秒级

### 记录

- `scripts/profile-phase1.ts`
- `benchmarks/phase1-profile-2026-04-13.json`
- `docs/performance-phase1-profile-2026-04-13.md`

### 稳定经验

只要端到端延迟已经明显异常，就不要靠直觉猜是哪一层慢。
在继续改 schema 前，先做函数级 profiling。

## 坑 6：snapshot 结果直接改变了整个阶段的结论解释

### 症状

live 运行告诉我们“还是输”，但 snapshot 运行却告诉我们“warm path 其实已经好了”。

### 为什么这很关键

它把两件不同的事实拆开了：

- warm steady-state path 其实已经足够快
- live source activity 仍然让 gate 过度失效

### 稳定经验

必须把下面两类 benchmark 分开看：

- steady-state performance
- live mutable-source performance

这两类 benchmark 不是一回事，通常也需要不同修复手段。

## 坑 7：在 selective sync 和 batched insert 之后，性能故事又变了一次

### 结果

最终的 live targeted benchmark 已经明确转成 warm-path 正收益：

- `benchmarks/phase1-targeted-live-final-2026-04-13.json`
- `docs/performance-phase1-live-final-2026-04-13.md`

### 稳定经验

不要在“第一轮修复有效”之后就停下。
每次做完结构性变更，都要重新跑 targeted benchmark，因为最终结论可能会整段翻转。
