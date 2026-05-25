# T5 测试用例 — Backpressure Channel Split + Multi-Gateway Fanout (PR #38)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T5-multigateway-backpressure` at commit `a4c31a9`; based on `main` (now T1+T2+T3+T3-followup).
> Authored **before** the substantive PR #38 review per the team's "test cases first" precedent ([#30 T3](https://github.com/Eliaaazzz/live-auction-system/pull/30) → [#35 T4](https://github.com/Eliaaazzz/live-auction-system/pull/35)).
>
> Schema:每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`. 用例分两类:
> - **覆盖型 (Coverage, TC-T5-001…010)** — 对应 PR #38 现有的 3 个 `_test.go` 用例 + 推断出来的合约级用例
> - **缺口型 (Gap probes, TC-T5-100…109)** — PR #38 未覆盖、但根据架构推理出的边界场景
>
> 优先级:**P0** 系统不可用 / 数据丢失 · **P1** 关键路径错误 · **P2** 自愈但可观测性差 · **P3** 极端/性能
>
> 注:CRITICAL lane = `send chan []byte, cap=64`(bid acks, AUCTION_*, ROOM_SNAPSHOT, catchup);LOSSY lane = `lossy chan []byte, cap=16`(PONG;未来 presence/chat)。`writePump` critical-first 优先级。

---

## 0. 用例索引

### 覆盖型 (10)

| ID | 标题 | 对应 PR #38 测试 | P |
|---|---|---|---|
| TC-T5-001 | CRITICAL lane 满 → 连接被 force-close,client 重连 + re-sync | `TestT5BackpressureCriticalDropsConn` | P0 |
| TC-T5-002 | LOSSY lane 满 → 该帧 drop,连接保持 | `TestT5BackpressureLossyDropsFrameKeepsConn` | P0 |
| TC-T5-003 | 多 gateway 同 auction → 一个 bid 被 fanout 到两个 client | `TestT5MultiGatewayFanout` | P0 |
| TC-T5-004 | CRITICAL frame drain 优先于 LOSSY (writePump priority) | (隐含,未独立测) | P1 |
| TC-T5-005 | force-close 后 hub.leave 通过 read goroutine 触发,无死锁 | (隐含在 broadcast 注释) | P1 |
| TC-T5-006 | close() 幂等 — 多次调用安全 (closeOnce + send 通道不 close) | (隐含,未独立测) | P1 |
| TC-T5-007 | concurrent trySend + trySendLossy 在同 Conn 无 panic / race | (未测) | P0 (race) |
| TC-T5-008 | force-closed Conn 后续 trySend → 不 panic (channel 永不 close) | (未测) | P0 |
| TC-T5-009 | ws.go `eventsUpToSnapshot` filter 仍工作 (T2 PR #31 fix 没被 T5 破坏) | `TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq` | P0 (回归) |
| TC-T5-010 | hub.broadcast 在 RLock 期间调用 trySend → 不死锁,即使 trySend 触发 close | (隐含,未独立测) | P0 |

### 缺口型 (10) — PR #38 未覆盖

| ID | 标题 | 风险 | P |
|---|---|---|---|
| TC-T5-100 | 单个慢 client 真的不阻塞其他人 (n-1 fast + 1 frozen client,broadcast 延迟测量) | T5 价值核心,需 quantitative 证据 | P1 |
| TC-T5-101 | hub.broadcast 在 trySend 触发 close() 时,Conn 在 hub.rooms 里残留(close 不调 leave) | 内存泄漏 / 后续 broadcast 仍 enqueue 已死 conn | P1 |
| TC-T5-102 | 大量 LOSSY 帧涌入 + 1 个 critical 帧 → critical 是否真的优先? (writePump select 公平性) | priority 不能保证(Go select 是 pseudo-random) | P1 |
| TC-T5-103 | bufferedAmount 1MB/4MB threshold (V9 §0 ⑧) — 当前未实现,PR body 承认 T8 | T8 perf gate,需文档明确 | P2 |
| TC-T5-104 | multi-gateway under load (200 events catchup < 1s concurrently) | T8 perf gate | P2 |
| TC-T5-105 | gateway A 死掉时,其在 hub.rooms 中的 conn 是否被清理? | gateway 进程崩溃后 stale conn 残留 | P1 |
| TC-T5-106 | trySend 时 done 已 closed → 仍写入 send channel,channel 不会 panic 但堆积 | 内存堆积 | P2 |
| TC-T5-107 | catchup 帧 (≤ snap.Seq) 与 fanout 帧 (> snap.Seq) 都用 CRITICAL lane — 同 64 cap 是否够? | catchup 200 + fanout burst 可超 64 | P1 |
| TC-T5-108 | PubSub 转发的 AUCTION_EXTENDED 帧用 trySend (CRITICAL),但它本质是 "事件" — 一致性? | 与 T2 anti-snipe 设计 alignment | P3 |
| TC-T5-109 | force-close 触发 hub.leave 的 "deferred to read goroutine" 路径在 reconnect-storm 下是否回收够快 | n × close-leave-rejoin cycle | P3 |

---

## 1. 覆盖型用例

### TC-T5-001 — CRITICAL lane 满 → force-close

- **前置条件**: `Conn{send: chan(cap=2), lossy: chan(cap=2), done: chan}`
- **测试步骤**:
  1. `c.trySend([]byte("a"))` → send 入队
  2. `c.trySend([]byte("b"))` → send 入队(cap=2 现满)
  3. `c.trySend([]byte("c"))` → 超 cap
  4. 检查 `c.done` 是否 closed
- **预期结果**: 第 3 次 trySend 触发 close(); `<-c.done` 立即返回(非阻塞)
- **意义**: 慢 client 不能拖累整个 room,但 critical event 也不能 silent drop — force-close 是正确的权衡
- **优先级**: P0

### TC-T5-002 — LOSSY lane 满 → 单帧 drop,连接保持

- **前置条件**: `Conn{send: chan(cap=2), lossy: chan(cap=1), done: chan}`
- **测试步骤**:
  1. `c.trySendLossy([]byte("a"))` → lossy 入队(cap=1 现满)
  2. `c.trySendLossy([]byte("b"))` → 超 cap,丢弃
  3. 检查 `c.done` 仍未 closed,`len(c.lossy) == 1`
- **预期结果**: 连接保持,仅丢失第 2 个 lossy frame
- **意义**: heartbeat / presence 不重要,丢一个无所谓,不应该为此踢人
- **优先级**: P0

### TC-T5-003 — multi-gateway fanout

- **前置条件**: Redis 已起,LIVE auction 存在
- **测试步骤**:
  1. 起 hubA + hubB(各自 subscribe Pub/Sub)
  2. cA join hubA, cB join hubB(同 aid)
  3. PlaceBid 一次
  4. 等 cA + cB 都收到 `BID_ACCEPTED`(deadline 4s)
- **预期结果**: 两个 conn 都收到帧 — Pub/Sub + Stream 是 cross-gateway fanout 的载体,不需要 shared hub
- **意义**: T5 horizontal scale 的核心 — 多 gateway 可以横向扩,无单点
- **优先级**: P0

### TC-T5-004 — writePump CRITICAL-first priority

- **前置条件**: Conn 启动 writePump,critical 1 帧 pending + lossy 100 帧涌入
- **测试步骤**:
  1. 同时 c.trySend(critical) + c.trySendLossy x100
  2. 测量 critical 帧到达 socket 的时间 vs lossy 100 帧
- **预期结果**: critical 应在 lossy 100 帧之前到达 socket (priority 工作)
- **意义**: 防止 lossy flood 把 critical 推后
- **当前实现**: writePump 用 "select default" 模式 — 先非阻塞 check critical,只有 critical 空才 select 上 lossy。理论上对的,但需验证
- **优先级**: P1
- **是否已测**: ❌

### TC-T5-005 — force-close 后 hub.leave 由 read goroutine 触发

- **前置条件**: Conn 在 hub.rooms,trySend 触发 close()
- **测试步骤**: 1. force-close conn  2. 检查 hub.rooms 是否 leave
- **预期**: close() 关 socket → read goroutine 出错退出 → handleWS defer s.hub.leave(c) → leave。**不是立即**
- **疑问**: 在 close 与 leave 之间的窗口内,如果有新的 hub.broadcast,它会尝试 trySend 到一个已 closed-socket 的 conn — trySend 写 channel 是 OK (channel 没 close),但 writePump 已经 return (done closed),frame 永远不被消费。下次 broadcast 触发 trySend → channel 满 → 又 close()(已 closed,no-op via closeOnce)。最终 leave。OK,自愈但有窗口期 enqueue 死信。
- **意义**: 文档化的设计,需要测试明确这个窗口的行为
- **优先级**: P1
- **是否已测**: ❌

### TC-T5-006 — close() 幂等

- **前置条件**: Conn{done: chan, closeOnce}
- **测试步骤**: c.close(); c.close(); c.close()
- **预期**: 仅 done 被 close 一次,没有 panic
- **优先级**: P1
- **是否已测**: ❌(closeOnce 在 code 中显式用,但 unit test 缺失)

### TC-T5-007 — concurrent trySend + trySendLossy + close() race

- **前置条件**: Conn,启动 N 个 goroutine 并发调用 trySend / trySendLossy / close
- **测试步骤**: 在 `-race` 下跑 100ms
- **预期**: 无 panic,无 race detector 报告
- **意义**: 真实场景:Pub/Sub fanout goroutine + writePump + read goroutine 都可能并发触碰
- **优先级**: P0 (race-safety)
- **是否已测**: ❌

### TC-T5-008 — force-closed Conn 后续 trySend 不 panic

- **前置条件**: Conn 已 closeOnce.Do 跑过
- **测试步骤**: 再 trySend / trySendLossy 多次
- **预期**: 不 panic (send channel 永不 close,只是没人消费 → 满 → 触发 close again no-op)
- **意义**: 设计 invariant — 文档明确说 "send 通道永不 close 以避免 panic-on-send-to-closed"
- **优先级**: P0
- **是否已测**: ❌

### TC-T5-009 — eventsUpToSnapshot filter 没被 T5 破坏 (回归)

- **前置条件**: T2 PR #31 fix `eventsUpToSnapshot` 还在
- **测试步骤**: 现有 `TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq`
- **预期**: 仍 PASS
- **意义**: 回归 — T5 没动 dispatch handler,但应该 sanity check
- **优先级**: P0 (回归)
- **是否已测**: ✅(继承自 T2 测试)

### TC-T5-010 — hub.broadcast 在 RLock 内调 trySend 触发 close,不死锁

- **前置条件**: hub 持 RLock 时,trySend 满 → close()
- **测试步骤**: 多个 conn 在同 room,其中一个 buffer 满,另一个空闲
- **预期**: broadcast 完成,close 通过 closeOnce → done channel close → read goroutine 看 socket close 退出 → defer leave → leave 等 RLock 释放后再获取 Lock
- **意义**: `Hub.broadcast` 注释明确说 "close() defers the hub.leave to the read goroutine, so it can't deadlock under this RLock"。需测试证实
- **优先级**: P0 (deadlock = system stall)
- **是否已测**: ❌

---

## 2. 缺口型用例

### TC-T5-100 — 慢 client 真的不阻塞其他人 (quantitative)

- **前置条件**: 1 个 "frozen" Conn(不消费 send),N 个正常 Conn
- **测试步骤**:
  1. 起 N=10 normal + 1 frozen,全在同 room
  2. broadcast 100 帧
  3. 测量 normal Conn 收到第 100 帧的时间
- **预期**: normal Conn 应在 < 100ms 内收完,frozen Conn 被 force-close,room 大小恢复 N
- **意义**: T5 backpressure 设计的核心 SLO claim — 需要数字证明,不是单元测试
- **优先级**: P1
- **是否已测**: ❌(单帧 force-close 测了,但 quantitative 多 client 没测)

### TC-T5-101 — force-close 与 hub.rooms 清理的窗口期

- **前置条件**: Conn close 后 hub.leave 未触发
- **测试步骤**:
  1. trySend 触发 close
  2. 立即 hub.broadcast 同 aid (在 read goroutine reschedule 前)
  3. 检查 trySend 是否堆积到死 conn (channel 仍打开)
- **预期**: trySend 写入 channel 一次,再次 broadcast → 又满 → 又 close(no-op)→ 帧最终累积在 send buffer,永远不被消费
- **风险**: 内存堆积。一个 conn 64-byte 帧 × 64 buffer = 4KB,可忽略。但是 leak 在 hub.rooms map(2 字段:channel 64 cap + lossy 16 cap + done + closeOnce + 几个 string)
- **建议**: close() 应主动调 hub.leave(self) 而不是依赖 read goroutine,或者 trySend 检测到 done closed 就直接 return 不入队
- **优先级**: P1
- **是否已测**: ❌

### TC-T5-102 — writePump priority 不公平 (Go select 是 pseudo-random)

- **场景**: writePump 第一个 select 是 critical-first(只看 c.done 和 c.send,default 后跳出)。第二个 select 是 c.done / c.send / c.lossy 三向(random)
- **问题**: 如果 critical buffer 经常空,但 lossy 持续涌入,critical 一进来时 writePump 已经在第二个 select 等 lossy,会 random 选哪个
- **数学**: 单帧 critical 到达时,如果 lossy 也有 pending,Go runtime random 选 → 50% concurrent — 不是真正 "critical first"
- **缓解**: writePump 的 default 后再回 loop 顶,重新进第一个 select,所以 critical 顶多 delay 1 lossy 帧。可接受。但 PR 注释说 "critical-first" 可能略 overclaim
- **预期(建议)**: 加 quantitative test:1 critical + 1000 lossy 并发涌入,测 critical 落地是不是在前 10 帧内
- **优先级**: P1
- **是否已测**: ❌

### TC-T5-103 — bufferedAmount 1MB/4MB 未实现

- **PR body 承认**: "bufferedAmount 1MB/4MB thresholds (RFC §0 ⑧) ... T8 load-tested items"
- **当前**: 没有 bufferedAmount 监控 / 强制断连
- **风险**: 64-cap channel + 64-byte frame ≈ 4KB per conn — 远低于 RFC 的 1MB threshold,但 channel 满即 close,所以实际生效的是 channel cap,不是 byte threshold
- **建议**: doc 应明确 "PR #38 用 channel cap 64 作为 backpressure 边界,不是 byte threshold。如果将来支持大帧(>1KB),需要 byte-based threshold 替换"
- **优先级**: P2
- **是否已测**: ❌(deferred to T8)

### TC-T5-104 — multi-gateway under load

- **场景**: 2 个 gateway,每个 100 conn,1 bid → 200 fanout
- **预期(SLO)**: 所有 200 conn 在 < 200ms 收到 BID_ACCEPTED
- **当前**: TC-T5-003 仅测 2 conn,无 load
- **优先级**: P2(T8 perf)
- **是否已测**: ❌

### TC-T5-105 — gateway 崩溃时 stale conn 清理

- **场景**: gatewayA 进程 SIGKILL,其 hub 内的 conn 全死
- **当前实现**: 进程死了,hub 内存也没了,问题不存在(每 gateway 独立 hub)
- **但**: 如果 gateway 部分死(write goroutine panic 但 read 还活),hub.rooms 留 stale conn
- **预期**: read goroutine 必然先看到 socket error 退出 → defer leave → 清理
- **优先级**: P1
- **是否已测**: ❌(进程崩溃场景需 chaos test,不是 unit)

### TC-T5-106 — trySend 在 done closed 后仍入队

- **前置条件**: c.close() 已跑(done closed,send 仍打开)
- **测试**: trySend([]byte("late"))
- **预期**: 当前实现 → 入 send channel,permanent in buffer。下次 broadcast 又入,直到 cap 满 → 又 close(no-op)
- **修法**: trySend 在 default 前加 done check:`select { case <-c.done: return; case c.send <- b: ; default: c.close() }`
- **优先级**: P2 (内存,极小;但 cleanup 应该确定)
- **是否已测**: ❌

### TC-T5-107 — catchup 200 帧 + fanout burst 可能超 critical cap 64

- **场景**: 客户端 lastSeq=0,auction 已有 200 events,catchup 一次性 push 200 帧(均经 CRITICAL lane)
- **当前实现**: 200 帧 > cap 64 → 立即 force-close,client 看不到 ROOM_SNAPSHOT,reconnect,可能进入死循环
- **预期(我担心)**: 这不是理论 — `catchupMaxGap=200` 直接对接 `send cap=64`,数学上必然失败
- **现实**: writePump 持续 drain,可能赶上 enqueue。但如果 client 慢,200 写 64 cap 必然满
- **建议**: 要么 catchup 用大 cap(e.g. send cap=256),要么 catchup 分批 + 间隔 ack
- **优先级**: P1
- **是否已测**: ❌

### TC-T5-108 — AUCTION_EXTENDED 走 CRITICAL — 一致性

- **AUCTION_EXTENDED** 在 PR #38 没显式列在 CRITICAL/LOSSY 分类,但 ws.go 显示所有 enqueue 通过 c.push() → trySend → CRITICAL。 OK,默认。
- **预期**: 文档 / wire 表里明确 AUCTION_EXTENDED 是 critical(它含 endAtMs,客户端必须收到才能更新 timer)
- **优先级**: P3 (文档)
- **是否已测**: ✅(via TestT2 anti-snipe path)

### TC-T5-109 — reconnect-storm 下 close-leave-rejoin 速度

- **场景**: 1000 conn,触发 broadcast 满 → 1000 close → 1000 reconnect
- **预期**: 系统在 < 5s 内稳定
- **优先级**: P3 (T9 chaos drill)
- **是否已测**: ❌

---

## 3. 执行计划

- **覆盖型 (TC-T5-001..010)**:
  - 3 个已实现 (TC-T5-001/002/003)
  - 7 个建议补 — 尤其 TC-T5-007 (race), TC-T5-008 (post-close trySend), TC-T5-010 (broadcast deadlock)
- **缺口型 (TC-T5-100..109)**:
  - **P1 建议本 PR 或 T5-followup**: 100 (quantitative slow-client), 101 (close-leave window), 102 (priority fairness), 105 (stale conn), 107 (catchup > cap)
  - **P2/P3 deferred to T8/T9**: 103 (bufferedAmount), 104 (multi-gateway load), 106 (post-close trySend cleanup), 108 (doc), 109 (reconnect storm)

## 4. 评审历史

- v1 (2026-05-25, @fariZzzz) — 初稿,基于 commit `a4c31a9`
