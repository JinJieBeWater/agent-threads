# 第一阶段精简后冷路径快照基准（2026-04-13）

这份文档记录最近一轮 rebuild 精简之后，在静态快照上的 cold-path 测量结果。

原始数据：

- `benchmarks/phase1-cold-snapshot-post-streamline-2026-04-13.json`

测量使用的是同一份静态快照 source root：

- `/tmp/ath-codex-snapshot-1776076381`

## 结果

| 场景 | 当前结果 | baseline 中位数 | 相对差异 |
| --- | ---: | ---: | ---: |
| cold `inspect index` | `5.62s` | `3.31s` | 约慢 `1.7x` |
| `admin reindex` | `5.82s` | `3.51s` | 约慢 `1.7x` |

## 解读

相对上一轮 post-batch 数字，这是一轮渐进式的 cold-path 改善。

cold path 仍然没有超过原始 baseline，但差距又进一步缩小了。

当前剩余的主要 cold-path 成本，已经收敛到：

- session parsing
- FTS 整表回填

thread metadata 和 tracked-source 写入，已经不再是 rebuild 的主要成本。
