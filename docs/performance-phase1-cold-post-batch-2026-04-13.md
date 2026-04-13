# 第一阶段批量重建后的冷路径基准（2026-04-13）

这份文档记录在把 full rebuild 改成以下形态之后的定向 cold-path 测量：

- 向 `messages` 做批量插入
- 对 `messages_fts` 做单次整表 `INSERT ... SELECT` 回填

原始数据：

- `benchmarks/phase1-cold-post-batch-2026-04-13.json`

## 结果

| 场景 | 当前结果 | baseline 中位数 | 相对差异 |
| --- | ---: | ---: | ---: |
| cold `inspect index` | `6.12s` | `3.31s` | 约慢 `1.9x` |
| `admin reindex` | `5.63s` | `3.51s` | 约慢 `1.6x` |

## 解读

相对第一阶段更早期的数字，这已经是一次有意义的 cold-path 改善：

- cold `inspect index` 已从两位数秒级降到约 `6.1s`
- 显式 `admin reindex` 已降到约 `5.6s`

cold path 仍然没有超过原始 baseline，但现在已经接近得多。
