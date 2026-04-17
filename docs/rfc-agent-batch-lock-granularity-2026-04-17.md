# RFC: ath Agent Batch Lock Granularity

Status: Implemented

Author: Codex

Date: 2026-04-17

Branch: `ath-multi-source-central-index`

Implementation note:

- default read commands now use bounded-stale behavior
- exact thread/message lookups retry after a stale miss when a writer is active
- explicit `admin reindex` uses shadow build + swap
- auto-repair rebuilds triggered inside normal read commands currently stay in-place for stability

## 1. Summary

`ath` 目前的索引锁粒度过大，不适合 agent 批量并发调用。

当前 read path 默认都会先经过 `ensureIndex()`，而 `ensureIndex()` 在需要同步时会把整段 sync / rebuild 过程包进同一个全局 `.lock` 文件。结果是：

- 一批 agent 并发调用 `find` / `recent` / `inspect thread` 时，很容易在预查询同步闸门上相互阻塞
- 只要其中一个进程进入较慢的 incremental sync 或 full rebuild，其它进程就会等待，甚至报 `index-lock-timeout`
- 锁争用成本主要来自 sync gate，而不是实际查询 SQL

本 RFC 提议把现有“整段 build 持锁”的模型改成：

- read path 默认允许使用“可用但可能略旧”的 index
- sync 采用 single-flight writer，但不再阻塞已可用 index 上的并发查询
- incremental sync 和 rebuild 都拆成“长耗时准备阶段”与“短事务提交阶段”
- `--refresh` / `admin reindex` 继续提供严格 freshness 语义

目标不是简单延长等待时间，而是把 `ath` 调整成适合 agent 批量读请求的本地检索工具。

## 2. Problem

### 2.1 当前行为

目前大多数 read 命令都走 `withReadyIndex()`，它会先调用 `ensureIndex()`，只有成功后才真正执行查询。

相关现状：

- `withReadyIndex()` 在查询前统一调用 `ensureIndex()`。
- `ensureIndex()` 在 `canSkipIncrementalSync()` 失败后，先 `waitForUnlockedIndex()`，再用 `withIndexBuildLock(...)` 包住整个同步过程。
- `.lock` 文件有独立的轮询等待和 15 秒超时逻辑。
- `rebuildIndexUnlocked()` 在持锁期间会扫描源目录、解析所有 session、构建线程消息，再进入 SQLite 事务写入。
- `synchronizeIncrementalUnlocked()` 虽然把 DB 更新包进事务，但整段扫描、读源文件、构建 plan 的过程也发生在外层全局锁持有期间。

这意味着当前 `.lock` 不是一个“短事务提交锁”，而是一个“整个 sync pipeline 的排他锁”。

### 2.2 为什么这在 agent 场景里会放大

agent 的调用模式和手工 CLI 使用不一样：

- 经常一次并发触发多条 `ath` 命令
- 经常是批量 `inspect` / `find` / `open`，并不关心每一条都必须强一致
- 很多请求只是为了做上下文检索，允许读取一个短时间窗口内略旧但可用的索引

在这种模式下，当前锁模型的问题会被放大：

1. 多个进程几乎同时进入 `ensureIndex()`
2. 其中一个进程拿到锁并开始 sync / rebuild
3. 其它进程在真正查询前就被挡住
4. 持锁时间如果超过 15 秒，部分请求直接失败

这不是 SQLite 本身无法支持并发读，而是 `ath` 在 SQLite 之外又加了一层更粗的用户态全局锁。

### 2.3 当前模型的根本缺陷

当前模型把三件不同的事绑成了一个锁边界：

- writer election：谁来负责这次同步
- source scanning / parsing：谁来读源目录和解析 session
- DB commit：谁来写 index.sqlite

真正必须串行化的是最后一项，不是前两项。

## 3. Evidence

代码和文档已经能说明问题：

- `src/handlers.ts` 中的 read path 几乎都依赖 `withReadyIndex()`
- `src/indexer.ts` 中 `ensureIndex()` 在需要同步时会进入全局锁
- `src/infra/lock.ts` 中 `.lock` 的等待与超时是进程级外部锁，不区分读和写
- `src/indexer-sync.ts` 中 full rebuild 在持锁期间执行全量扫描和解析
- `docs/fts-retrospective-benchmarking-2026-04-13.md` 已记录“并行 benchmark 复用同一索引会触发锁竞争”
- `docs/performance-phase1-targeted-2026-04-13.md` 也记录了并行尝试因为锁竞争无效

此外，已有 profiling 结论指出，真正昂贵的是 `ensureIndex()` 这个 sync gate，而不是查询层本身。

## 4. Goals

- 让 agent 并发批量调用 `ath` 时，不再因为正常的 sync 竞争而频繁报锁错误
- 让有可用 index 的 read 请求，尽量不被 writer 阻塞
- 缩短真正需要排他的临界区，只把 DB commit 留在短锁内
- 保留显式 strict freshness 语义，用于 `--refresh`、`admin reindex`、调试与验证
- 不引入 index 损坏、双写乱序、或来源状态错乱

## 5. Non-Goals

- 不在本 RFC 中直接改成 multi-source central index
- 不追求跨机器或网络分布式锁
- 不要求同一时刻允许多个 writer 同时写一个 index
- 不要求每个 read 请求都必须读到源目录的最新瞬时状态

## 6. Proposal

## 6.1 总体策略

把现在的“全局 build 锁”改成“single-flight sync lease + 短提交锁 + bounded-stale read”。

核心语义：

- 只允许一个 writer 负责某次 sync
- 只在真正提交到 `index.sqlite` 时持有短排他锁
- 如果当前 index 可用，read 命令默认不因为另一个进程正在 sync 而阻塞
- 如果用户显式要求 strict freshness，才等待正在进行的 sync 完成

## 6.2 新鲜度语义

为 read path 引入 freshness mode：

- `strict`
  语义接近当前行为。需要确认本次命令执行前 index 已同步到最新可见源状态。
- `bounded-stale`
  如果 index 可用，则允许直接查询当前 index；若发现后台已有 writer 在同步，则不等待 writer 完成。
- `bootstrap-only`
  仅在 index 不可用或不存在时等待构建；一旦 index 可用，后续读请求不再因为同步中的 writer 而被阻塞。

建议默认行为：

- 普通 read 命令默认使用 `bounded-stale`
- `--refresh` 强制 `strict`
- `admin reindex` 强制 `strict`

这比新增一个只给 agent 用的私有模式更合适，因为它把语义做成了显式系统行为，而不是“agent 特例”。

## 6.3 Reader 行为

新的 read path 规则：

1. 先判断 index 是否存在且结构可用
2. 如果 index 不可用：
   - 必须等待 writer 完成 bootstrap，或自己成为 bootstrap writer
3. 如果 index 可用且 `canSkipIncrementalSync()` 为 true：
   - 直接查询
4. 如果 index 可用且 `canSkipIncrementalSync()` 为 false：
   - 若没有 active writer，当前进程尝试成为 writer
   - 若已有 active writer，直接查询现有 index，不等待

这样可以保证：

- 冷启动时仍能构建出可用 index
- steady-state 下的读不会被持续写锁拖死
- agent 批量命令在有人同步时仍能读旧索引，而不是排队撞超时

## 6.4 Exact-match Miss Recovery

bounded-stale read 会引入一个实际问题：

- 某个线程刚写入源目录，但 index 还没同步
- 这时 `inspect thread <id>` 或 `open <id>` 可能返回 not found

为避免把这种短暂滞后直接暴露成假阴性，read path 应加入一次性补救策略：

- 当命令是 exact thread lookup
- 当前 freshness mode 不是 `strict`
- 当前进程观察到 active writer 或刚检测到 source changed
- 且第一次查询返回 `thread-not-found`

则执行一次“等待当前 writer 完成后重试”的慢路径。

这样既保留高吞吐，又不至于把刚产生的新线程稳定误报为不存在。

## 6.5 Writer Election

把当前 `.lock` 文件语义改成 sync lease，而不是读写总闸门。

lease 内容至少包含：

- pid
- started_at
- mode: `incremental` | `rebuild`
- target index path
- optional generation / epoch

lease 的用途：

- 保证同一 index 同时只有一个 writer 在推进
- 让其它进程知道“已有同步在进行”
- 不再要求普通 reader 在 lease 存在时必须阻塞

## 6.6 Incremental Sync: 两阶段

incremental sync 应拆成两个阶段：

### Phase A: Prepare

在不持有 commit lock 的情况下：

- 读取 source 状态
- 扫描 session 文件
- 解析受影响 thread
- 构建 sync plan
- 记录本次 plan 依据的 source snapshot / fingerprint / logs high water

### Phase B: Commit

仅在真正写 SQLite 时持有 commit lock：

- 重新校验 source fingerprint / logs high water 是否仍满足 plan 前提
- 前提未变化则进入 DB 事务提交
- 前提变化则丢弃 plan，重新 prepare

这样可以把现在最重的 IO 和 JSONL parsing 从排他锁里移出去。

## 6.7 Full Rebuild: Shadow Build + Atomic Swap

full rebuild 不应长时间占用线上 index 的外部锁。

推荐做法：

1. 在旁路路径构建 shadow DB，例如 `index.sqlite.next`
2. 对 shadow DB 完整初始化、灌入数据、生成 FTS
3. 完成后获取短 commit lock
4. 原子替换主 index 文件
5. 清理旧的 `-wal` / `-shm` / 临时文件

这样 full rebuild 的大部分时间不会阻塞现有 reader。

如果原子替换在当前 Bun / SQLite 使用方式下有实现复杂度，也可以先落一个较弱版本：

- 先做 incremental 的两阶段拆分
- rebuild 仍单 writer，但 lease 存在时 reader 可继续读旧 index

## 6.8 `canSkipIncrementalSync()` 的职责收敛

当前 `canSkipIncrementalSync()` 兼具两层含义：

- index 是否可读
- index 是否已经足够新

在新模型下，这两层要拆开：

- `isIndexUsable()`
  只回答“这个 index 能不能安全查询”
- `isIndexFreshEnough(...)`
  回答“按当前 freshness mode，是否还需要同步”

这样 read path 才能在“可用但不够新”的情况下继续提供服务。

## 6.9 Error Semantics

普通 read 命令在 index 可用时，不应再因为另一个 writer 持有 lease 而报：

- `index-lock-timeout`

该错误应只保留给以下场景：

- 冷启动时必须 bootstrap，但 writer 长时间没有完成
- `--refresh` 或 `admin reindex` 显式要求 strict freshness
- writer lease 确实异常，例如 stale lease 无法安全接管

## 7. Alternatives Considered

### 7.1 只把等待时间从 15 秒调大

不接受。

这只会把失败变成更慢的失败，不会提高 agent 批量吞吐，也不会减少临界区。

### 7.2 完全依赖 SQLite 自带锁，不保留用户态 lease

不接受。

SQLite 能保证 DB 写事务安全，但不能直接表达：

- 谁负责本轮 sync
- 哪个进程正在做长时间 prepare
- 何时允许其它进程做 bounded-stale 读取

single-flight writer 仍然需要一个轻量级协调机制。

### 7.3 每个进程都创建自己的临时索引

不接受。

这会造成：

- 重复扫描与解析
- 更高的 IO 与 CPU 成本
- 结果漂移
- agent 负载越高，系统越抖

这适合作为只读兜底，不适合作为常态并发模型。

### 7.4 对 thread 粒度加锁

当前不推荐。

因为当前 schema 仍有全局 `meta`、`sync_meta`、`messages_fts` 和 rebuild 路径，thread 级锁无法真正解决“一个 writer 长时间占全局闸门”的问题。

## 8. Rollout Plan

### Phase 1: Reader 不再因 writer lease 阻塞

- 保留单 writer
- index 可用时，read path 直接查询，不等待已有 writer
- `--refresh` / `admin reindex` 仍按 strict 行为等待
- exact thread lookup 增加一次 miss recovery

预期收益：

- 最快消除 agent 批量场景下的大部分锁报错
- 改动面相对可控

### Phase 2: Incremental Sync 拆成 prepare / commit

- prepare 在无 commit lock 下完成
- commit 前 revalidate
- 缩短 writer 的真正排他窗口

预期收益：

- 进一步降低 writer 对其它 writer 的阻塞时间
- 为更稳的 bounded-stale 语义打基础

### Phase 3: Rebuild 改成 shadow build + swap

- 重建 shadow index
- 短锁切换
- 清理旧文件

预期收益：

- 大幅降低 full rebuild 对线上读请求的影响

### Phase 4: 可观测性

增加 inspect 级别的可观测信息，例如：

- 当前是否存在 active writer
- 当前 freshness mode
- 当前查询是否命中了 stale read
- writer lease 的 age / pid / mode

## 9. Risks

### 9.1 读到略旧结果

这是设计上接受的 tradeoff。

风险控制手段：

- 只在 index 已可用时允许 bounded-stale
- exact thread lookup 失败时做一次性重试
- `--refresh` 继续提供 strict 模式

### 9.2 Prepare 与 Commit 之间源状态继续变化

这是两阶段模型的天然问题。

风险控制手段：

- commit 前做 fingerprint / logs high water revalidate
- 前提失效时直接丢弃 plan 重做

### 9.3 Shadow Swap 的文件切换复杂度

full rebuild 的 swap 需要谨慎处理：

- `-wal`
- `-shm`
- Windows 兼容性如果以后支持
- reader 正在打开旧 DB 的时机

因此它适合放到 rollout 后段，而不是和 reader 语义调整绑死一起上。

## 10. Success Criteria

修复完成后，应满足以下性质：

- 多个 agent 并发执行 read 命令时，常态下不再出现 `index-lock-timeout`
- steady-state 下，read 请求即使遇到后台 sync，也应能从现有 index 返回结果
- `--refresh` 和 `admin reindex` 仍能提供明确的严格同步语义
- rebuild / incremental sync 的排他窗口明显短于当前实现
- benchmark 与真实 agent 批量调用都不再需要通过“强制串行化 `ath`”来规避锁问题

## 11. Open Questions

1. bounded-stale 是否应成为所有 read 命令默认行为，还是只在检测到 agent 环境变量时启用
2. stale read 是否需要在 JSON 输出里显式标注，例如 `meta.freshness = "stale-ok"`
3. exact lookup 的 miss recovery 应覆盖哪些命令：`inspect thread`、`open`，还是也包括 `export`
4. rebuild 的 shadow swap 是继续沿用同一 `index.sqlite` 路径，还是引入代际命名

## 12. Recommendation

优先落地 Phase 1 和 Phase 2。

原因很直接：

- 这两步已经能解决 agent 批量调用时最痛的锁粒度问题
- 它们不要求先完成更大的 schema 重构
- 它们把“读请求可继续服务”和“writer 只在必要时短暂排他”这两个关键能力先建立起来

不要把修复方向理解成“ath 要不要更强一致”。

这里真正需要修的是：

- 让读请求默认不再被整段同步流程绑死
- 让 writer 锁只覆盖真正必须串行的提交边界

对 agent 使用场景来说，这比继续调 timeout、继续串行化上层调用，或者要求调用方自己做锁规避，都更合理。
