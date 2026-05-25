# T5 测试用例 — Backpressure Channel Split + Multi-Gateway Fanout (PR #38)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T5-multigateway-backpressure` at commit `fe90763` (current HEAD). Drafted v1 against `a4c31a9`; v2 reflects post-review fixes; **v3** adds 2 executable probes after pull-and-test of `fe90763`.
> Based on `main` (now T1+T2+T3+T3-followup, post #31/#33 rollups).
> Executable gap probes (TC-T5-110/111) land in **PR #44** (`fari/T5-followup-gap-tests`, stacked on #38 — mirrors #33 for T3).
> Authored **before** the substantive PR #38 review per the team's "test cases first" precedent ([#30 T3](https://github.com/Eliaaazzz/live-auction-system/pull/30) → [#35 T4](https://github.com/Eliaaazzz/live-auction-system/pull/35)).
>
> Schema:每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`. 用例分两类:
> - **覆盖型 (Coverage, TC-T5-001…010)** — 对应 PR #38 现有的 5 个 `_test.go` 用例(v1 = 3,v2 + 2)+ 推断出来的合约级用例
> - **缺口型 (Gap probes, TC-T5-100…111)** — PR #38 未覆盖、但根据架构推理出的边界场景(110/111 v3 落地为 executable)
>
> 优先级:**P0** 系统不可用 / 数据丢失 · **P1** 关键路径错误 · **P2** 自愈但可观测性差 · **P3** 极端/性能
>
> 注:CRITICAL lane = `send chan []byte, cap=sendBufFrames=256`(bid acks, AUCTION_* events incl. AUCTION_EXTENDED, ROOM_SNAPSHOT, catchup);LOSSY lane = `lossy chan []byte, cap=16`(PONG;未来 presence/chat)。`writePump` **best-effort** critical-first 优先级(单 in-flight lossy 帧 delay bound,Go select 是 pseudo-random fairness)。**Invariant**: `sendBufFrames > catchupMaxGap` (256 > 200) — pinned in `TestT5CatchupFitsInSendBuffer`。

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
| TC-T5-007 | concurrent trySend + trySendLossy 在同 Conn 无 panic / race | **✅ 落地为 executable** `TestT5ConcurrentCloseVsSendFloodIsRaceClean` (PR #44 — 见 TC-T5-110,更强:并发 close() 同时跑) | P0 (race) |
| TC-T5-008 | force-closed Conn 后续 trySend → 不 panic + 不入队 (`fe90763` 加 leading done-check) | `TestT5TrySendAfterCloseDoesNotEnqueue` (v2 新加) | P0 |
| TC-T5-011 | catchup 200 帧填入 critical lane(cap=256)→ no force-close,no drop | `TestT5CatchupFitsInSendBuffer` (v2 新加;invariant `sendBufFrames > catchupMaxGap`) | P0 |
| TC-T5-009 | ws.go `eventsUpToSnapshot` filter 仍工作 (T2 PR #31 fix 没被 T5 破坏) | `TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq` | P0 (回归) |
| TC-T5-010 | hub.broadcast 在 RLock 期间调用 trySend → 不死锁,即使 trySend 触发 close | (隐含,未独立测) | P0 |

### 缺口型 (12) — 状态映射(v2 起部分已修;v3 + 2 个 executable 探针 PR #44)

| ID | 标题 | v3 状态 (`fe90763`) | P |
|---|---|---|---|
| TC-T5-100 | 单个慢 client 真的不阻塞其他人 (n-1 fast + 1 frozen client,broadcast 延迟测量) | 仍 open — T5 价值核心 quantitative 验证,需 follow-up | P1 |
| TC-T5-101 | hub.broadcast 在 trySend 触发 close() 时,Conn 在 hub.rooms 里残留 | **✅ FIXED in `fe90763`** — `trySend`/`trySendLossy` 加 leading `<-c.done` non-blocking 检查,post-close 帧直接 drop 不入队。Pinned 在 `TestT5TrySendAfterCloseDoesNotEnqueue` | P1 (resolved) |
| TC-T5-102 | 大量 LOSSY 帧涌入 + 1 个 critical 帧 → critical 是否真的优先? (writePump select 公平性) | **✅ DOC TIGHTENED in `fe90763`** — `writePump` 注释 + `ws-envelope.md §Backpressure` 改为 "best-effort priority",显式说明 "critical frame 可被 1 个 in-flight lossy write delay (Go select pseudo-random fairness)"。Strict priority 仍 out-of-scope | P1 (doc-resolved) |
| TC-T5-103 | bufferedAmount 1MB/4MB threshold (V9 §0 ⑧) — 当前未实现,PR body 承认 T8 | 仍 deferred 到 T8 | P2 |
| TC-T5-104 | multi-gateway under load (200 events catchup < 1s concurrently) | 仍 deferred 到 T8 | P2 |
| TC-T5-105 | gateway A 死掉时,其在 hub.rooms 中的 conn 是否被清理? | 仍 open — 进程崩溃场景需 chaos test | P1 |
| TC-T5-106 | trySend 在 done closed 后仍入队 | **✅ FIXED in `fe90763`** — 与 TC-T5-101 同 patch,leading done-check 阻止入队 | P2 (resolved) |
| TC-T5-107 | catchup 200 帧 + fanout burst 可能超 critical cap | **✅ FIXED in `fe90763`** — `sendBufFrames=256` 替换原 cap=64;invariant `sendBufFrames > catchupMaxGap` pinned 在 `TestT5CatchupFitsInSendBuffer`。**Was P1 correctness bug;现已闭环。** Residual headroom (`256-200=56` 帧) 在 concurrent fanout 下的边界已 quantify 为 TC-T5-111(T8 load,非 correctness) | P1 (resolved) |
| TC-T5-108 | PubSub 转发的 AUCTION_EXTENDED 帧分类 | **✅ DOC FIXED in `fe90763`** — `ws-envelope.md` 现在明确 "`AUCTION_*` events incl. `AUCTION_EXTENDED`" 在 critical lane | P3 (resolved) |
| TC-T5-109 | force-close 触发 hub.leave 的 "deferred to read goroutine" 路径在 reconnect-storm 下是否回收够快 | 仍 open — T9 chaos drill 议题 | P3 |
| TC-T5-110 | concurrent close() racing trySend/trySendLossy flood → race-clean + 收敛 closed | **✅ EXECUTABLE in PR #44** — `TestT5ConcurrentCloseVsSendFloodIsRaceClean`,16×500 sender 并发 + close()×2;验证 leading done-check 的残留 TOCTOU + "channels never closed" invariant 在 `-race` 下安全。本地 PASS | P0 (race) |
| TC-T5-111 | catchup headroom 边界:`sendBufFrames-catchupMaxGap` 帧之外 catchup 仍会 force-close | **✅ EXECUTABLE in PR #44** — `TestT5CatchupHeadroomBoundary`,prefill=headroom 存活 / headroom+1 force-close。这是 TC-T5-107 的 residual,@Eliaaazzz CR 要求 relocate 到 T8 load 的那条。本地 PASS | P2 (T8 load) |

**Summary**: v1 raised 10 gap probes;v2 `fe90763` 闭了 **5 个** (101, 102 doc, 106, 107, 108)。剩余 P1 是 TC-T5-100 (quantitative slow-client SLO) + TC-T5-105 (stale conn after gateway-crash);T8 deferred (103, 104);T9 deferred (109)。

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

### TC-T5-101 — force-close 与 hub.rooms 清理的窗口期 ✅ FIXED in `fe90763`

- **v1 场景 (against `a4c31a9`)**: `Conn.close()` 不调 `hub.leave`,leave 依赖 read goroutine 的 defer。close 与 leave 之间,broadcast 仍会 trySend 到死 conn → 帧累积在 send buffer 永不被消费
- **v2 fix**: `trySend` + `trySendLossy` 都加 leading `<-c.done` non-blocking check,post-close 帧直接 drop 不入队。Pinned 在新测 `TestT5TrySendAfterCloseDoesNotEnqueue`:close 后 100 次 trySend + 100 次 trySendLossy,两条 buffer 都保持 len=0
- **现状**: RESOLVED

(原 v1 分析,保留以便对比):

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

### TC-T5-102 — writePump priority 不公平 ✅ DOC TIGHTENED in `fe90763`

- **v1 分析**: 单 critical 帧若到达时 lossy buffer 也有 pending,Go select 是 pseudo-random,critical 顶多被 1 个 lossy 帧 delay
- **v2 fix**: 文档/注释从 "drained with priority" 改为 "**best-effort priority**",显式 bound: "a pending critical frame pre-empts a pending lossy one in the leading non-blocking poll; under Go's pseudo-random select fairness a critical frame can be delayed by at most one in-flight lossy write" (`ws.go` writePump comment + `proto/ws-envelope.md §Backpressure`)。Strict priority (additional non-blocking critical poll after each lossy write) 仍 deferred 因为 v0 scale 不必要
- **现状**: 文档对齐 implementation,不 overclaim。RESOLVED at doc level

(原 v1 分析,保留以便对比):

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
- **建议**: doc 应明确 "PR #38 v2 用 channel cap **256** 作为 backpressure 边界,不是 byte threshold。如果将来支持大帧(>1KB),需要 byte-based threshold 替换"
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

### TC-T5-106 — trySend 在 done closed 后仍入队 ✅ FIXED in `fe90763`

- 与 TC-T5-101 同 patch (leading `<-c.done` non-blocking check in `trySend`/`trySendLossy`)
- 现在 post-close 帧 drop 不入队;Pinned 在 `TestT5TrySendAfterCloseDoesNotEnqueue`
- RESOLVED

(原 v1 分析,保留以便对比):

- **前置条件**: c.close() 已跑(done closed,send 仍打开)
- **测试**: trySend([]byte("late"))
- **预期**: 当前实现 → 入 send channel,permanent in buffer。下次 broadcast 又入,直到 cap 满 → 又 close(no-op)
- **修法**: trySend 在 default 前加 done check:`select { case <-c.done: return; case c.send <- b: ; default: c.close() }`
- **优先级**: P2 (内存,极小;但 cleanup 应该确定)
- **是否已测**: ❌

### TC-T5-107 — catchup 200 帧 vs critical lane cap ✅ FIXED in `fe90763`

- **v1 场景 (against `a4c31a9` cap=64)**: 客户端 lastSeq=0,auction 已有 200 events,catchup 一次性 push 200 帧(均经 CRITICAL lane)。 200 帧 > cap 64 → 必然 trip trySend force-close,client 看不到 ROOM_SNAPSHOT,reconnect 进入死循环
- **本地验证 (v1)**: probe 跑 `make(chan, 64)` + 无 drain 的 200 trySend → 第 65 次精确触发 force-close ✓
- **v2 fix (`fe90763`)**: 引入 `sendBufFrames = 256` 常量,`Conn.send` 使用之。Pinned **invariant** `sendBufFrames > catchupMaxGap` 在新测 `TestT5CatchupFitsInSendBuffer` 中: 跑 200 frame replay → 不 force-close + 不 drop。Compile-test 风格的 `if sendBufFrames <= catchupMaxGap { t.Fatalf(...) }` 防止未来重构动一个常量不动另一个
- **现状**: P1 correctness bug RESOLVED;T8 perf 时可考虑大 chain auctions (>200 events) 的 paced-catchup 优化但非 correctness 关切
- **v3 residual (quantified, TC-T5-111)**: `TestT5CatchupFitsInSendBuffer` 证明的是 **cold buffer** 吃下 catchupMaxGap。real flow 里 lane 不 cold — `ROOM_SNAPSHOT` + 并发 fanout 先占位 — 所以真实 headroom 只有 `sendBufFrames-catchupMaxGap = 56` 帧。我 pull #38 后用 `TestT5CatchupHeadroomBoundary` 把边界钉死:prefill 56 + replay 200 = cap 存活;prefill 57 + replay 200 → 最后一帧 force-close(genuine overload 下的 intended fail-safe)。这是 **T8 load 关切,非 P1 correctness** — 正是 @Eliaaazzz CR 要求 relocate 的那条

### TC-T5-108 — AUCTION_EXTENDED 走 CRITICAL ✅ DOC FIXED in `fe90763`

- **v1 状态**: code 通过 `c.push() → trySend → CRITICAL` 实际走 critical lane,但 `ws-envelope.md` 表述为 "`AUCTION_*` terminals" 只覆盖 SOLD/NO_BID/CANCELLED — AUCTION_EXTENDED 分类含糊
- **v2 fix**: `proto/ws-envelope.md §Backpressure` 改为 "`AUCTION_*` events incl. `AUCTION_EXTENDED`",显式说明 AUCTION_EXTENDED 在 critical lane(它含 endAtMs,客户端必须收到才能 update timer)
- 现状: RESOLVED

### TC-T5-109 — reconnect-storm 下 close-leave-rejoin 速度

- **场景**: 1000 conn,触发 broadcast 满 → 1000 close → 1000 reconnect
- **预期**: 系统在 < 5s 内稳定
- **优先级**: P3 (T9 chaos drill)
- **是否已测**: ❌

### TC-T5-110 — concurrent close() racing send-flood 必须 race-clean ✅ EXECUTABLE (PR #44)

> 这是 v3 新增的 executable 探针。方法论:pull #38 @ `fe90763`,挑战 fix 新增的代码路径,不是 re-run elia 已有的测试。

- **前置条件**: `Conn{send: chan(cap=sendBufFrames), lossy: chan(cap=16), done: chan}`;一个 drain goroutine 代替 writePump(让赢得 race 的 sender 不会全 wedge 在满 buffer 上)
- **测试步骤**:
  1. 起 16 个 sender goroutine,每个 500 次 `trySend` + `trySendLossy`
  2. 同时起 1 个 closer goroutine 调 `c.close()` 两次(验 `closeOnce` 幂等,无 double-close panic)
  3. 全部 join 后检查 `c.done` 是否 closed
- **输入数据**: senders=16, perSender=500
- **预期结果**:
  - `-race` 下无 panic、无 race detector 报告
  - 残留 TOCTOU(leading done-check 通过 → close 触发 → enqueue 落地)是 bounded by design,不导致 panic
  - "`send`/`lossy` 通道永不 close" invariant 成立 — 任何把通道 close 掉或丢掉 `closeOnce` 的回归都会在这里 panic-on-send-to-closed 或 race
  - 终态 `c.done` closed(收敛)
- **意义**: TC-T5-007 的 executable 版且更强(加了并发 close);fe90763 fix 的 race-safety 回归 guard
- **本地结果**: ✅ PASS under `-race`
- **优先级**: P0 (race-safety)

### TC-T5-111 — catchup headroom 边界(TC-T5-107 的 T8 residual)✅ EXECUTABLE (PR #44)

- **前置条件**: `headroom := sendBufFrames - catchupMaxGap`(= 256-200 = 56)
- **测试步骤**:
  1. **at_headroom_survives**: prefill `headroom` 帧(模拟 ROOM_SNAPSHOT + 并发 fanout 占位),再 replay `catchupMaxGap` 帧 → 检查未 force-close 且 `len(send)==sendBufFrames`
  2. **over_headroom_force_closes**: prefill `headroom+1` 帧,再 replay `catchupMaxGap` → 检查 `c.done` closed(replay 最后一帧触发 force-close)
- **输入数据**: 参数化用常量推导,不写死,所以未来调 `sendBufFrames`/`catchupMaxGap` 任一,边界自动跟随
- **预期结果**:
  - prefill ≤ headroom:catchup 全程不 force-close(`TestT5CatchupFitsInSendBuffer` 是 prefill=0 的特例)
  - prefill > headroom:catchup 会 force-close — 这是 genuine overload 下的 **intended fail-safe**,不是 bug
- **意义**: quantify TC-T5-107 的 residual。fix 把 catchup-force-close 从 "任意 catchup 都触发"(v1 cap=64 < 200)降到 "只在 lane 已被 >56 帧占位时触发" — 后者是 T8 load 边界,非 P1 correctness。@Eliaaazzz CR 明确要求把这条 relocate 到 T8 load/perf
- **本地结果**: ✅ PASS(两个 subtest)
- **优先级**: P2 (T8 load characterization)

---

## 3. 执行计划

- **覆盖型 (TC-T5-001..011)**:
  - **v1: 3 个已实现** (TC-T5-001/002/003)
  - **v2 `fe90763`: + 2 个** (TC-T5-008 `TestT5TrySendAfterCloseDoesNotEnqueue`,TC-T5-011 `TestT5CatchupFitsInSendBuffer`)
  - **v3 PR #44: TC-T5-007 落地** — `TestT5ConcurrentCloseVsSendFloodIsRaceClean`(executable,更强)
  - 4 个仍建议补 — TC-T5-004 (writePump priority quantitative), TC-T5-005 (close-vs-leave window timing), TC-T5-006 (close 幂等独立测), TC-T5-010 (broadcast-触发-close 在 RLock 内无死锁)
- **缺口型 (TC-T5-100..111)**:
  - **✅ RESOLVED in `fe90763`**: TC-T5-101 (close-leave window via leading done-check), TC-T5-102 (priority wording → "best-effort"), TC-T5-106 (post-close drop, same patch as 101), TC-T5-107 (catchup>cap via sendBufFrames=256 + invariant test), TC-T5-108 (AUCTION_EXTENDED doc classification)
  - **✅ EXECUTABLE in PR #44** (stacked on #38,本人 pull fe90763 实测验证 fix): TC-T5-110 (concurrent close race-clean), TC-T5-111 (catchup headroom 边界 = 107 的 T8 residual)
  - **仍 open — P1 建议 T5-followup**: TC-T5-100 (quantitative slow-client SLO), TC-T5-105 (gateway-crash stale conn)
  - **Deferred to T8 perf**: TC-T5-103 (bufferedAmount), TC-T5-104 (multi-gateway under load), TC-T5-111 (headroom under concurrent-fanout 的 load-scale 验证)
  - **Deferred to T9 chaos**: TC-T5-109 (reconnect storm)

## 4. 评审历史

- v1 (2026-05-25, @fariZzzz) — 初稿,基于 commit `a4c31a9`,标记 3 P1 (107 cap, 101 close-leave, 102 priority doc) + 1 P3 (108 doc)
- v2 (2026-05-25, @fariZzzz) — 对齐 `fe90763`: 5 缺口型 resolved (101/102/106/107/108);新加 2 覆盖型 (TC-T5-008/011 对应 `TestT5TrySendAfterCloseDoesNotEnqueue` + `TestT5CatchupFitsInSendBuffer`);invariant `sendBufFrames > catchupMaxGap` pinned 在测试。 Eliaaazzz PR #39 CR 要求 doc 反映 current head 而非 v1 head — 本次更新满足
- v3 (2026-05-25, @fariZzzz) — 独立 re-verify `fe90763`:pull #38,`go test -race ./...` 全绿,`TestT5MultiGatewayFanout` 对真实 Redis/MySQL 通过。新增 2 个 executable 探针挑战 fix 本身(非 re-run):**TC-T5-110** `TestT5ConcurrentCloseVsSendFloodIsRaceClean`(并发 close vs flood race-clean)+ **TC-T5-111** `TestT5CatchupHeadroomBoundary`(catchup headroom 边界 = TC-T5-107 的 T8 residual,正是 @Eliaaazzz CR 要求 relocate 到 load/perf 的那条)。executable 版落在 PR #44(stacked on #38)。结论:fix solid,两个 P1 正确闭环
