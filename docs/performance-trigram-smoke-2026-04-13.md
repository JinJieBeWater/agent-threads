# Trigram 冒烟检查（2026-04-13）

这份文档记录第一版由 trigram 驱动的 `messages_fts` 原型落地后的定向 post-implementation smoke check。
它是一份历史事故记录，对应的是同一轮会话中后续 sync-path 修复之前，那版已损坏原型的状态。

原始机器可读数据保存在：

- `benchmarks/trigram-smoke-2026-04-13.json`

## 目的

这轮运行的目的，不是产出一张完整精修过的 benchmark 表。
它只是想尽快回答一个更窄的问题：

- 当前 trigram 实现是否已经足以改善端到端 CLI 延迟，从而值得沿着同一路线继续推进？

在当时记录这份结果时，答案是否定的。

## 方法

这些命令端到端地对 `~/.codex` 运行，使用一份全新的临时索引 `/tmp/ath-post-impl.sqlite`。

执行顺序：

1. 用全新临时索引跑 cold `inspect index`
2. 对同一份临时索引跑 warm `inspect index`
3. 对同一份临时索引跑 warm `find notify_url --kind message --limit 20`

使用 `/usr/bin/time -p` 计时。

## 结果

| 场景 | 当前 trigram 原型 | baseline 中位数 | 相对差异 |
| --- | ---: | ---: | ---: |
| cold `inspect index` | `24.13s` | `3.31s` | 约慢 `7.3x` |
| warm `inspect index` | `198.13s` | `6.61s` | 约慢 `30.0x` |
| warm `find "notify_url" --kind message` | `257.21s` | `7.19s` | 约慢 `35.8x` |

baseline 参考：

- `docs/performance-baseline-2026-04-13.md`

## 解释

这不是小幅回退。
当前原型在下面两条路径上，都比 trigram 改造前的 baseline 慢得非常夸张：

- 索引创建 / rebuild 路径
- warm read 路径

这意味着当前实现不应该被视为一次成功的性能迭代。

## 可能原因

当前原型里最可能的几个主要原因是：

1. trigram 索引被维护成一张额外的 standalone FTS 表，所以 rebuild 现在要把整份 message text 写两遍。

2. `insertMessages()` 当前会在插入消息之后，按每个 touched thread 再次 `SELECT` 其全部行来重灌 `messages_fts`，这会在 rebuild 与 incremental sync 中额外放大写成本。

3. warm read 命令仍然主要被 `ensureIndex()` preflight 主导，所以即使原始文本搜索本身更快，端到端路径依然会很贵。

## 建议的下一步

不要把当前 standalone trigram 表视为最终实现。

继续之前，应该先做下面几件事：

1. 要么回退这个原型，要么明确把它只当成实验分支
2. 重做 FTS maintenance path，避免反复 rebuild 和 reinserting 这么多文本
3. 单独优化 sync fast path，因为它在 baseline 的 warm read 中本来就已经是主成本

如果 trigram 仍然在路线图上，下一轮实现必须建立在一套新的 write-path 设计上，而不是在当前原型上继续硬修。
