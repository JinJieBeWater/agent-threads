# 第一阶段 selective sync 之后的 live 基准（2026-04-13）

这份文档记录引入日志感知 selective sync 路径之后，第一次针对 live `~/.codex` 的定向 benchmark。

原始数据：

- `benchmarks/phase1-targeted-live-post-selective-2026-04-13.json`

## 结果

| 场景 | 当前 live 结果 |
| --- | ---: |
| cold `inspect index` | `12.75s` |
| warm `inspect index` | `1.08s` |
| warm `find "notify_url"` | `0.29s` |
| warm `find "payment"` | `0.28s` |
| `admin reindex` | `16.45s` |

## 解读

和更早的 live 运行相比，这是第一组看起来像“真正 warm-read 获胜”的结果：

- warm `inspect index` 已经接近 `1s`
- warm message search 已明显低于 `1s`
- cold start 和显式 rebuild 仍然远慢于原始 baseline

## 实际结论

当前实现看起来已经跨过门槛，进入了有意义的 steady-state 与 live warm-read 改善区间。

现在仍然偏贵的部分：

- cold `inspect index`
- `admin reindex`

现在看起来已经不错的部分：

- warm `inspect index`
- 针对有代表性的代码风格 token 与自然语言 token 的 warm message search
