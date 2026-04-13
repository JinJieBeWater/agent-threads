# FTS 复盘：同步路径踩坑（2026-04-13）

这份文档记录了本次 FTS 改造中，sync 路径上的主要错误和修正。

## 坑 1：mtime 精度不一致，导致出现误判 rebuild

### 症状

一些实际上没有发生有效变化的文件，仍然会被判定成“已变化”。

### 根因

文件系统里的 `mtimeMs` 精度，与持久化下来的整数毫秒值，没有做一致化归一。

### 稳定修复

- 持久化和比较时都统一归一到整数毫秒

### 状态

- 已修复

## 坑 2：`thread_sources` 如果按“每线程一行”建模，粒度过粗

### 症状

多文件线程无法被准确表达。
同一个线程下的 sibling shard 会从 bookkeeping 模型里消失。

### 根因

更早的 sync 模型，只为每个线程跟踪一个“代表性路径”。

### 稳定修复

- bookkeeping 改成“每个 source file 一行”

### 状态

- 已修复

## 坑 3：过期的 `rolloutPath` 和路径优先级错误，会让错误文件赢掉

### 症状

warm sync 有时会错误相信 state metadata 里的旧路径，而不是当前已跟踪的最新路径。

### 稳定修复

- 在可用时，tracked current path 成为最高优先级事实来源

### 状态

- 已修复

## 坑 4：过期 sibling tracked path 的清理，起初不能稳定落库

### 症状

即使 sync pass 真正需要做的唯一事情只是清掉陈旧路径，这些 stale path 行也可能残留不删。

### 稳定修复

- 为 delete-only cleanup 单独提供写入路径，并补上测试覆盖

### 状态

- 已修复

## 坑 5：过粗的 fingerprint 会带来 stale read 风险

### 症状

某一阶段里，即使 live session shard 已经变化，fast path 仍然可能错误 skip。

### 根因

fingerprint 粒度太粗，在真实 source file 已漂移的情况下，仍然可能被误信为可复用。

### 稳定修复

- 把 trusted-host fast path 与 synthetic / partial source 行为彻底分离
- 用测试补上 live shard change 覆盖

### 状态

- 已修复

## 坑 6：一个“便宜”的 fast path，如果仍然要全量扫描 source tree，就根本不便宜

### 症状

实现重新变正确之后，warm read 仍然要先遍历整个 source tree，才能决定是否 skip。

### 稳定修复

- 从 hot path 中移除 eager 的全树 source scan
- 引入 trusted-host selective checks 与 conservative fallback checks

### 状态

- 已修复

## 坑 7：把 `logs_2.sqlite` 当成粗暴失效源，噪声太大

### 症状

任何日志增长，都可能直接打穿 warm-read fast path。

### 根因

最开始把 `logs_2.sqlite` 当成一个粗粒度变化 blob，而不是结构化的活动来源。

### 稳定修复

- 将 `logs` 用作 active-thread signal
- trusted selective sync 只关注最近活跃的线程

### 状态

- 已修复

## 坑 8：trusted fast path 起初漏掉了 parser version 失效条件

### 症状

parser 升级之后，旧的 trusted index 仍然可能看起来“可用”。

### 稳定修复

- 把 parser version 纳入 usable-index gate

### 状态

- 已修复

## 坑 9：即便已经按线程做 selective sync，热点多分片线程仍然会付出过高成本

### 症状

即便引入 selective sync，只要某个热点线程分片很多，处理它时仍然可能偏贵。

### 当前理解

这也是为什么在最后一轮 selective-sync 调整前，live benchmark 的 warm 成本仍然偏重的剩余原因之一。

### 当前状态

- 已部分改善
- 如果未来 warm path 再次回归，仍值得优先复查

## 稳定的同步指导原则

如果以后还要继续碰这块代码，下面这些不变量必须保住：

1. trusted host fast path 和 synthetic fallback path 必须继续分离
2. parser version 必须继续属于 usable-index gate 的组成部分
3. activity signal 必须是结构化信号，而不是粗暴的 file-size / mtime blob
4. 多分片线程必须继续在 bookkeeping 与测试中作为一等公民对待
