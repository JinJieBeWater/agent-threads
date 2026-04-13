# 性能基线（2026-04-13）

这份文档记录当前 `ath` 实现在 trigram 改造之前的 baseline。
它的作用，是为后续搜索路径与 sync 路径改动后的对比提供锚点。

原始机器可读样本保存在：

- `benchmarks/baseline-2026-04-13.json`

## 范围

这份 baseline 覆盖的是端到端 CLI 墙钟时间，包括：

- 针对一份全新临时索引的首次读取
- 针对已有临时索引的 warm read 命令
- 通过 `admin reindex` 显式触发的完整 rebuild

所有 warm 命令耗时，都包含当前 `ensureIndex()` 的 no-op sync preflight。
它们不是纯 SQL 查询耗时。

## 环境

- 记录时间：`2026-04-13T04:29:34.172Z`
- 主机：`darwin arm64`
- CPU：`Apple M5`（`10` 核）
- 内存：`24 GiB`
- Bun：`1.3.11`
- source root：`~/.codex`

## 数据集

- 线程数：`963`
- 消息数：`40,627`
- source built_at：`2026-04-13T04:27:30.276Z`

warm benchmark 生成的索引产物大小：

- `index.sqlite`：`185,417,728` 字节
- `index.sqlite-wal`：`603,683,032` 字节
- `index.sqlite-shm`：`1,179,648` 字节

## 方法

使用的命令：

```bash
bun scripts/benchmark-baseline.ts --cold-samples 2 --warm-samples 3
```

等价的 Make 目标：

```bash
make benchmark-baseline
```

这份 benchmark 脚本会：

- 使用当前工作区里的 `src/index.ts`
- 默认指向调用者自己的 `~/.codex` source root
- 将所有 benchmark 数据写入一份临时 benchmark 索引
- 不会改动 `~/.agent-threads/index.sqlite`

## 结果

| 场景 | 命令 | 样本数 | 中位数 | 最小值 | 最大值 |
| --- | --- | ---: | ---: | ---: | ---: |
| cold 初次读取 | `inspect index` | 2 | `3306 ms` | `3261 ms` | `3351 ms` |
| warm inspect | `inspect index` | 3 | `6609 ms` | `6564 ms` | `7231 ms` |
| warm recent | `recent --limit 20` | 3 | `6660 ms` | `6620 ms` | `6802 ms` |
| warm 查标识符 | `find "notify_url" --kind message --limit 20` | 3 | `7189 ms` | `7053 ms` | `7362 ms` |
| warm 查 token | `find "payment" --kind message --limit 20` | 3 | `7220 ms` | `7195 ms` | `7220 ms` |
| warm 查短语 | `find "epay callback" --kind message --limit 20` | 3 | `7289 ms` | `7254 ms` | `7477 ms` |
| 显式 reindex | `admin reindex` | 3 | `3506 ms` | `3398 ms` | `3506 ms` |

## 发现

1. warm read 命令稳定地比一次完整显式 rebuild 更慢。
   在这组数据上，`inspect`、`recent` 和有代表性的 `find` 命令都聚集在 `6.6s` 到 `7.5s`，而 `admin reindex` 大约只需 `3.5s`。

2. 当前瓶颈并不只是 rebuild 路径。
   由于 warm read 结果已经包含 no-op sync preflight，这强烈说明主成本来自每次读命令之前重复做的 sync readiness 工作。

3. 当前 message search 成本，在标识符、token 和短语查询之间几乎是平的。
   `notify_url`、`payment` 和 `epay callback` 都落在大约 `7.2s` 这一档，说明当前路径更像是被 preflight 与宽泛文本扫描主导，而不是由 query-specific selectivity 决定。

4. 这份 baseline 很适合作为 trigram 改造的 “before” 快照。
   后续所有 trigram 对比，都应该使用同一数据形态、同一命令集、同一样本数，以便隔离出改动是否真正改善了：
   - warm `find --kind message`
   - warm read-path 相对 `admin reindex` 的延迟
   - 索引文件大小与 WAL 增长

## 后续

当 trigram 方案落地后，应该重新运行同一组命令，并重点对比：

- `warm_find_message_notify_url`
- `warm_find_message_payment`
- `warm_find_message_epay_callback`
- `admin_reindex`
- warm 索引产物大小

第一条成功标准应该尽量简单：

- warm message search 必须显著低于当前大约 `7.2s` 的 baseline
- query latency 不应该再比显式 full rebuild latency 高出这么大的量级
