# FTS 复盘：搜索 / 表结构 / 写入路径踩坑（2026-04-13）

这份文档记录了本次 FTS 重写中，搜索路径与 schema 设计上的主要错误。

## 坑 1：standalone trigram 让正文翻倍，也放大了写成本

### 症状

第一版 trigram 原型在 rebuild 和 warm read 上都明显更慢。

### 根因

实现里维护了一张 standalone trigram 表，重复存储 message text，同时又以过于激进的方式反复重灌它。

### 记录

- `docs/performance-trigram-smoke-2026-04-13.md`

### 状态

- 已替换

## 坑 2：按线程级别重建 FTS 内容，成本太高

### 症状

只要某个线程被 touched，代码就会把这个线程对应的整份 FTS 内容重新灌一遍。

### 稳定修复

- 改成按 message row 粒度维护

### 状态

- 已修复

## 坑 3：words-first 路径最初的 fallback 范围太宽

### 症状

只要 FTS miss 或报错，整条查询就可能直接退回 contains，导致新主路径的收益非常容易被冲掉。

### 稳定修复

- fallback 现在会限制 query shape

### 状态

- 已修复

## 坑 4：trusted host 与 synthetic fixture 行为一开始混在了一起

### 症状

trusted-host fast-path 行为的测试，最初使用的是并不真正满足 trusted-host 契约的 synthetic fixture。

### 稳定修复

- 明确引入 trusted-manifest fixture setup
- 将这类测试与 conservative-path 测试拆开

### 状态

- 已修复

## 坑 5：在 profiling 证伪之前，大家太早把锅甩给了查询 SQL

### 症状

最自然的直觉是“FTS SQL 很慢”。

### 后来被证明的事实

- 查询 SQL 本身其实很便宜
- 昂贵的是 warm-path sync gating

### 状态

- 已澄清

## 坑 6：即便 warm path 变好了，cold path 仍然很贵

### 症状

即便 selective sync 已经让 warm read 变快，cold `inspect index` 和 `admin reindex` 仍然明显慢于 baseline。

### 根因

message insertion 仍然使用了过多 SQL 语句。

### 稳定修复

- batched multi-row message insert
- batched FTS insert

### 状态

- 已改善，但未彻底解决

## 当前稳定的搜索 / 表结构结论

这个工作树里第一阶段最终稳定下来的结论是：

- words-first message FTS 是正确主路径
- contains fallback 仍然需要保留，但必须只服务于受限 query shape
- 维护粒度必须落到 row level
- warm-path 的胜利，并不能证明 cold-path 也已经赢了

## 剩余未完成工作

当前 search / schema 相关的主要遗留问题，已经不是 warm-path 正确性，而是 cold-path 成本。

如果后面还要继续做，这条线上第一优先应该复查 rebuild cost，而不是先回去怀疑 query semantics。
