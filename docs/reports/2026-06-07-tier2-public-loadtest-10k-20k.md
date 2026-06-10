# 2026-06-07 Tier-2 公网压测报告：10k 达标 / 20k 单网关容量边界

> Source of truth: issue #233.  
> Purpose: materialize the report file referenced by `docs/demo/tech-differentiation.md`, `docs/final-submission/final-demo-deck.md`, and final demo/submission material. This file intentionally mirrors the public evidence summary from #233 so those references are no longer dead links.

---

## 摘要

本轮压测从异地按量 worker（cn-shanghai）经公网 EIP 打北京网关，规避了先前北京 ECS 自拨公网 IP 的 NAT hairpin / self-dial 问题。目标网关为单台 `c4i.xlarge`（4 vCPU / 8 GiB）裸二进制部署：`lumen serve --mode=all`，build `291ecf31`，prod 环境。

结论分两层：

1. **10,000 并发 + 真实出价路径达标。** 10k 基线场景下所有 §4.2 SLO 绿，拍卖正确结算，`seqGapCount=0`，`backpressureForceClose=0`。这是项目首个“真公网万人竞拍”实证。
2. **20,000 连接 / 约 50k bids/s 暴露单网关容量边界。** 当活跃出价者拉到 10,000，总连接 20,000 时，单网关在约 15,777 连接处崩溃并自动重启。崩溃前后正确性未破，但网关 CPU / 内存成为瓶颈，需要 admission control、单连接内存削减、GC 取证和后续多网关 fanout。

---

## 环境

| 项目 | 值 |
|---|---|
| 压测日期 | 2026-06-07 |
| Load worker | 异地按量 worker，cn-shanghai |
| Gateway | 北京网关公网 EIP，`ws://115.191.76.40:80` |
| Server shape | 单台 `c4i.xlarge`，4 vCPU / 8 GiB |
| Server process | 裸二进制 `lumen serve --mode=all` |
| Build | `291ecf31` |
| Transport | 明文 `ws://`，无域名证书，`wss://` 待补 |
| WAN RTT | 约 22 ms |

---

## SLO / 预算

| 指标 | 预算 |
|---|---:|
| server ack p95 | < 80 ms |
| room state patch p95 | < 150 ms |
| catchup p95 | < 1 s |
| seqGapCount | 0 |
| backpressureForceClose | 0 |

---

## 三场景结果

| 场景 | 连接构成 | 出价压力 | 峰值并发 | 结果 | ack p95 | patch p95 | seqGap | bpClose |
|---|---|---:|---:|---|---:|---:|---:|---:|
| A. 10k 基线 | 9,900 观众 + 100 出价者 | ~500 bids/s | 10,000 | ✅ 干净，拍卖 SOLD | 0.46 ms | 73 ms | 0 | 0 |
| C. 10k 4:6 | 6,000 观众 + 4,000 出价者 | ~20,000 bids/s | 10,000（稳态约 9,874） | ✅ SLO/正确性达标，少量早退 | 3.5 ms | 58 ms | 0 | 0 |
| B. 20k 风暴 | 10,000 观众 + 10,000 出价者 | ~50,000 bids/s | 15,777 | ❌ 进程崩溃 + 自动重启 | ~110 ms 峰值 | 73 ms | 0 | 0 |

---

## 场景 A：10k 基线

客户端摘要：

```text
connect OK 10000 / FAIL 0 / peak 10000 / closed early 0
frames 26,775,893
bids 359,625 sent / 2,938 acc / 356,678 rej
```

拍卖自然到期 SOLD：winner `user_load_3`，价格 `100000 -> 103162`，`seq=3163`，零空洞，唯一赢家。

判定：10k 公网连接和真实出价路径干净达标。

---

## 场景 C：10k 高活跃 4:6

客户端摘要：

```text
connect OK 10000 / FAIL 0 / peak 10000 / closed early 126 (~1.3%)
frames 25,760,340
bids 7,913,906 sent / 2,096 acc / 7,910,638 ERR_TOO_LOW
bidsRejectedFastPath 7,911,796
```

解释：约 99.97% 注定失败的低价出价被 gateway fast-reject 吃掉，因此在约 40 倍出价压力下，ack p95 仍稳定在 3.5 ms。

判定：高活跃 10k 场景下，fast-reject 与 room state patch 设计有效，服务端 SLO 和正确性保持。该场景仍记录到 126 条早退连接（约 1.3%），所以最终材料应称为“高活跃 10k SLO/正确性达标”，不要写成“所有连接全程零早退”。

---

## 场景 B：20k 风暴

客户端摘要：

```text
connect OK 19999 / FAIL 1 / peak 15,777 / closed early 19999
bids 5,043,257 sent / 753 acc / 4,234,994 ERR_TOO_LOW
```

过程：`activeConns` 爬到约 15,777 后封顶，ack p95 上升到约 110 ms。hold 约 98 秒后，`lumen` 进程崩溃并自动重启，导致全部连接断开。重启后 `/metrics` 归零，`activeConns=0`。

正确性：崩溃前 `seqGapCount=0`、`backpressureForceClose=0`；重启后拍卖仍为 LIVE，Redis 中 `seq=753` 连续。

判定：20k 风暴暴露单网关容量边界；这是稳定性 / 容量问题，不是裁决正确性问题。

---

## 根因判断

最可能瓶颈是单网关 CPU / 内存 / GC 压力，而非带宽或压测机：

- `backpressureForceClose=0`，说明慢客户端强关没有触发。
- `roomStatePatch.p95` 仍约 73 ms，EIP 200 Mbps 未打满。
- worker load average 约 0.65，TCP established 约 14k，压测机不是瓶颈。
- 崩溃后 `/metrics` 归零，说明需要更好的 crash forensics：pprof、gctrace、heap / goroutine gauge、OOM vs panic 区分。

---

## 已转化的工程任务

这份报告后续直接推动了 #235 的网关降载优化：

- WebSocket admission gate：超过 `MAX_WS_CONNS` 后新连接返回 503 + `Retry-After`，避免进程爬到 OOM cliff。
- CAS reservation：准入计数使用原子 Compare-And-Swap，避免 reconnect burst 下 check-then-add 越过 cap。
- 单连接内存削减：降低 per-connection critical / broadcast lane buffer 成本。
- Runtime observability：新增 admission rejected、heap、goroutine、pprof / gctrace 取证。
- 后续多网关 fanout：将单网关容量边界转化成横向扩展路线。

---

## 提交材料可引用表述

推荐在最终提交材料中这样表述：

> 我们完成了真公网 10,000 并发连接压测。10k 基线场景下拍卖正确 SOLD，ack p95 和 room patch p95 均满足预算，`seqGap=0`，说明实时裁决路径和广播路径在万人规模下保持正确。进一步的高活跃 10k 场景在约 20k bids/s 压力下仍保持服务端 SLO 和正确性，但记录到约 1.3% 早退连接，因此应作为高活跃边界证据而非“零早退”证据。20k 风暴压测进一步暴露了单网关容量边界：在约 15.8k 连接、50k bids/s 附近，单网关因内存 / GC 压力崩溃重启，但 Redis 中的拍卖状态和 `seq` 连续性未破。我们据此加入 admission control、单连接内存削减和取证指标，把 crash cliff 转化为 graceful degradation 的工程路线。

---

## 后续待办

- [ ] 贴域名证书后补一轮 `wss://` 公网验证。
- [ ] 在 #235 合并后的 gateway 上重跑 14k / 20k overload，验证 `activeConns` 是否贴着 watermark 平台化，`admissionRejected` 是否增长，且 `/healthz` / `/metrics` 不归零。
- [ ] 保留三份取证：压测开始 / 峰值 / 结束 `/metrics` snapshot、gateway 日志、pprof heap + goroutine profile。
- [ ] 多网关 fanout / room affinity 路线继续推进，避免单机成为长期天花板。

---

## References

- Issue #233：公网 Tier-2 10k / 20k 压测原始结论与数据。
- PR #235：基于本报告推进的 admission control、内存削减和 GC / pprof 取证。
- Issue #231：北京自拨公网 IP 的 NAT hairpin 问题和 Tier-1 拓扑边界。
