# FTS 改造前后权威对比（2026-04-13）

这份文档是当前项目关于本次 FTS 改造的**唯一权威前后对比说明**。

它只回答四件事：

1. 改造前后的查询技术是什么
2. 改造前后的索引技术是什么
3. 改造前后的同步技术是什么
4. 性能和结果质量最终前后差多少

其他性能文档、阶段性 benchmark 文档、profile 文档都作为原始记录保留，
但不再承担“最终前后结论”的角色。

## 对比口径

这里统一用两组对比来表达“前后”：

1. `main` 分支 vs 当前 `wip-ath-trigram-index` 分支
   用同一份 static snapshot 做公平对比
2. pre-FTS baseline vs 当前 live 最终实现
   用来回答真实使用路径是否已经得到改进

支撑原始记录：

- `docs/performance-baseline-2026-04-13.md`
- `docs/performance-compare-main-vs-current-snapshot-2026-04-13.md`
- `docs/performance-phase1-live-final-2026-04-13.md`
- `docs/performance-phase1-cold-post-batch-2026-04-13.md`
- `docs/performance-phase1-profile-2026-04-13.md`

## 技术前后对比

### 查询技术

| 项目 | 改造前 | 改造后 |
| --- | --- | --- |
| message query 主路径 | 普通 contains / `instr()` 扫描 | words-first FTS5 主路径 |
| fallback | 基本是 contains 本身 | contains 仅在 query-shape 允许时受控降级 |
| 擅长查询 | 宽泛子串包含匹配 | 开发型 token、代码型短语、配置词、回调链路词 |
| 排序基础 | 主要靠时间和命中后处理 | FTS 命中 + 现有去噪 / 时间后处理 |

一句话：

- 改造前更像“全表 contains 检索”
- 改造后更像“开发文本优先的 FTS 检索”

### 索引技术

| 项目 | 改造前 | 改造后 |
| --- | --- | --- |
| message index | 无正式 FTS 主索引 | `messages_fts` words-first FTS 主索引 |
| tokenizer | 无 | `unicode61` + `tokenchars` |
| FTS 存储形态 | 不适用 | `contentless_delete` 风格虚表 |
| 冷 rebuild 时 FTS 写入 | 不适用 | 先批量写 `messages`，再整表回填 `messages_fts` |

一句话：

- 改造前没有真正的消息 FTS 主索引
- 改造后第一次正式引入了消息 FTS 主索引

### 同步技术

| 项目 | 改造前 | 改造后 |
| --- | --- | --- |
| warm read preflight | `ensureIndex()` 经常退化成昂贵预检 | trusted-manifest + active-thread selective sync |
| trusted host source | 没有区分 | 只有可信宿主环境走 selective fast path |
| synthetic / partial source | 与真实 source 混用 | 明确回退到更保守路径 |
| live activity handling | 容易把整棵 source 一起打掉 | logs 驱动只同步活跃线程 |

一句话：

- 改造前 warm path 的主要问题是 sync 预检太重
- 改造后 warm path 已经变成 selective sync

## 性能前后对比

### A. `main` vs 当前分支（同一 static snapshot）

| 场景 | `main` | 当前分支 | 结论 |
| --- | ---: | ---: | --- |
| cold `inspect index` | `6.10s` | `6.67s` | 当前略慢 |
| warm `inspect index` | `6.89s` | `1.20s` | 当前约 `5.8x` 更快 |
| warm `recent --limit 20` | `6.86s` | `0.24s` | 当前约 `28x` 更快 |
| warm `find "notify_url"` | `9.97s` | `0.29s` | 当前约 `34x` 更快 |
| warm `find "payment"` | `9.80s` | `0.30s` | 当前约 `33x` 更快 |
| warm `find "epay callback"` | `7.19s` | `0.30s` | 当前约 `24x` 更快 |
| `admin reindex` | `5.60s` | `11.96s` | 当前约 `2.1x` 更慢 |

结论：

- 对重复使用的本地检索体验，当前分支是压倒性提升
- 对显式 rebuild / cold rebuild，`main` 仍然更轻

### B. pre-FTS baseline vs 当前 live 最终实现

| 场景 | baseline | 当前 live 最终结果 | 结论 |
| --- | ---: | ---: | --- |
| cold `inspect index` | `3.31s` | `8.78s` | 当前仍慢 |
| warm `inspect index` | `6.61s` | `0.76s` | 当前约 `8.7x` 更快 |
| warm `find "notify_url"` | `7.19s` | `0.28s` | 当前约 `25.7x` 更快 |
| warm `find "payment"` | `7.22s` | `0.28s` | 当前约 `25.9x` 更快 |
| `admin reindex` | `3.51s` | `9.67s` | 当前仍慢 |

结论：

- warm path 已经明确转成性能正收益
- cold path 还没有赢过 baseline

### C. cold-path 后续优化状态

在 static snapshot 上，后续 cold-path 优化已经把结果继续压到：

- cold `inspect index`: `5.62s`
- `admin reindex`: `5.82s`

这说明：

- cold path 还没赢
- 但已经从早期双位数秒压到接近 baseline 的 `1.7x`

## 结果质量前后对比

### 改造前

- 结果更多依赖 contains 命中本身
- 对开发型 token 的性能和体验都偏弱
- 对重复查询的可预测性较差

### 改造后

- 对开发型 token 检索明显更强
  - `notify_url`
  - `payment`
  - `epay callback`
- 对重复查询的稳定性更好
- 对 message 结果的 snippet 与过滤边界更合理

### 当前局限

- 对更泛的自然语言查询，结果质量仍只是中等
  - 例如 `error handling`
- 它现在更像“开发文本检索工具”，还不是“泛语义搜索引擎”

一句话：

- 如果主要搜变量名、配置名、短语、回调链路，当前质量是好的
- 如果目标是更语义化的自然语言检索，当前还不够

## 当前权威结论

当前仓库状态可以收敛成一句话：

> 本次改造第一次正式把 message FTS 主路径引入项目，并把 warm read / warm query 从 contains+重预检模型推进成了明显更快、结果质量也更适合开发型检索的版本；剩余主要短板已经明确收敛到 cold rebuild / cold-start 成本。

## 后续优化方向

后续如果继续做性能优化，优先级应是：

1. SQLite FTS5 bulk-load / merge / optimize
2. cold rebuild 中的 parse / canonical build 成本
3. 只有当结果质量成为主要问题时，才再做更强的 rerank / 去噪 / query 分类
