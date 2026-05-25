# T3 测试用例 — Timer Hammer + Seller Cancel (PR #29)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T3-hammer-cancel` at commit `24a2151`; rolled to `main` via PR #31.
> Base-chain status: PR #31 absorbs T2 + T3 onto `main`; the case set runs identically there.
>
> Schema (per @fariZzzz 5/25 directive):每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`. 用例分两类:
> - **覆盖型 (Coverage, TC-T3-001…020)** — 对应 PR #29 现有的 **20 个** `_test.go` 用例 (16 个 store-level: `lua_t3_test.go` + `lua_t3_hidden_test.go`; 4 个 server-level: `ws_t3_test.go` + `ws_t3_hidden_test.go`),作者 review 时也用作可执行清单
> - **缺口型 (Gap probes, TC-T3-100…107)** — PR #29 当前未覆盖、但根据架构推理出的边界场景,本 review 主张要么补测,要么解释为何安全
>
> 优先级:**P0** 系统不可用 / 资产丢失 / 状态分裂 · **P1** 关键路径功能错误 · **P2** 自愈但可观测性差 · **P3** 极端/罕见
>
> 注:所有 money 字段统一 `cents` (string-at-boundary, int64-internal); `endAtMs` 是 Unix ms; `Redis TIME` 是 Lua 内权威钟; `seq` 是状态机 `HINCRBY` 单调,与 Stream entry `<seq>-0` 严格对齐.

---

## 0. 用例索引

### 覆盖型 (20)

| ID | 标题 | 对应 PR #29 测试 | P |
|---|---|---|---|
| TC-T3-001 | Timer hammer LIVE → SOLD,winnerId 正确,Stream 无 gap | `TestCloseAuctionSold` | P0 |
| TC-T3-002 | Timer hammer LIVE 无出价 → NO_BID | `TestCloseAuctionNoBid` | P0 |
| TC-T3-003 | 未到期 close → ERR_NOT_DUE 返回当前 endAtMs,状态不变 | `TestCloseAuctionNotDue` | P0 |
| TC-T3-004 | 已 terminal 状态再 close → ERR_ALREADY_TERMINAL | `TestCloseAuctionAlreadyTerminal` | P1 |
| TC-T3-005 | §4.1 hammer-race oracle(顺序版):late bid 输给 close | `TestT3HammerRaceOraclePlaceBidLosesToClose` | P0 |
| TC-T3-006 | §4.1 hammer-race oracle(并发版):双 goroutine -race 下 late bid 永不胜 | `TestT3HammerRaceConcurrentLateBidNeverWins` | P0 |
| TC-T3-007 | LIVE 卖家 cancel → CANCELLED,后续 bid 拒绝 | `TestCancelAuctionLive` | P0 |
| TC-T3-008 | SCHEDULED 卖家 cancel → CANCELLED, AUCTION_CANCELLED@1-0 | `TestCancelAuctionScheduled` | P1 |
| TC-T3-009 | 非卖家 cancel → ERR_NOT_ALLOWED, 状态不变 | `TestCancelAuctionNotOwner` | P0 |
| TC-T3-010 | terminal 状态再 cancel → ERR_ALREADY_TERMINAL | `TestCancelAuctionAlreadyTerminal` | P1 |
| TC-T3-011 | sellerId 空字符串场景下 cancel 必须 fail-closed | `TestT3CancelFailClosedOnEmptySeller` | P0 |
| TC-T3-012 | SCHEDULED 状态 close 是 no-op,无 Stream 写入 | `TestT3CloseOnScheduledIsNoOp` | P1 |
| TC-T3-013 | LIVE 有最高出价时 cancel → CANCELLED(非 SOLD) | `TestT3CancelLiveWithBidsGoesCancelledNotSold` | P0 |
| TC-T3-014 | stream/state seq 失配 → preflight 拒绝,无 dirty write | `TestT3CloseSeqStreamMismatchNoDirtyWrite` | P0 |
| TC-T3-015 | 错误类型 key → ERR_INTERNAL,close/cancel 都拒绝 | `TestT3CloseCancelKeyTypeGuard` | P1 |
| TC-T3-016 | 双重 hammer 第二次 → ERR_ALREADY_TERMINAL,seq/stream 不变 | `TestT3CloseDoubleHammerSecondAlreadyTerminal` | P0 |
| TC-T3-017 | reconcile 自愈:LIVE 但失踪的 auction 被重新加入索引 | `TestT3TimerReconcileRetracksLostLiveAuction` | P0 |
| TC-T3-018 | E2E:Timer hammer 1.5s 周期后广播 AUCTION_SOLD,MySQL SOLD | `TestT3TimerHammerEndToEnd` | P0 |
| TC-T3-019 | E2E:LIVE cancel REST → 广播 AUCTION_CANCELLED + MySQL CANCELLED | `TestT3CancelLiveEndToEnd` | P0 |
| TC-T3-020 | E2E:DRAFT cancel 仅 MySQL,非卖家 403,重复 cancel 409 | `TestT3CancelDraftAndForbidden` | P1 |

### 缺口型 (8) — 现有用例未覆盖,本 review 主张补测

| ID | 标题 | 风险 | P |
|---|---|---|---|
| TC-T3-100 | DRAFT 与 freeze 并发时 cancel 是否会导致 MySQL/Redis 状态分裂 | TOCTOU,seller 损失 | P1 |
| TC-T3-101 | cancel.lua 成功但 `UpdateAuctionStatus` 失败 → 客户端见 500,persistence 是否最终一致 | 文档化的自愈是否真的发生 | P1 |
| TC-T3-102 | reconcile 间隔 (5s) 大于 auction durationMs (<5s) 且 TrackActive 在 start 时已失败 | 短拍卖错过 hammer 窗口 | P2 |
| TC-T3-103 | 双 Timer 实例 (`--mode=all` + `--mode=timer`) 同 auction 并发 close → 行为 | 文档承诺无害,需 e2e 验证 | P2 |
| TC-T3-104 | close.lua 返回 `ERR_INTERNAL{'seq_stream_mismatch'}` 时 Timer 无限重试 | 日志洪水,无收敛 | P2 |
| TC-T3-105 | cancel 与 timer hammer 并发 (并发 OK_CANCELLED vs OK_SOLD,看哪个胜) | 终态决定输赢 | P1 |
| TC-T3-106 | reconcile `ScanStateAIDs` 在 10K LIVE 拍卖下的 SCAN 成本 | T8 perf 隐患 | P2 |
| TC-T3-107 | 服务重启 mid-cancel(stream 有 AUCTION_CANCELLED, MySQL 仍 LIVE)→ persistence 初始 sweep 应补齐 | Stream-first 设计的正确性 | P1 |

---

## 1. 覆盖型用例 (基于 PR #29 已有实现)

### TC-T3-001 — Timer hammer LIVE → SOLD,Stream gap-free

- **前置条件**
  - Redis + MySQL 已启动,Lua scripts 已 `SCRIPT LOAD`
  - 创建一个 LIVE 拍卖 `aid`,duration 60s
  - `seq=0`,Stream 空
- **测试步骤**
  1. 卖家 freeze + start auction
  2. 买家 `u1` 出价 `11000`(`startPrice=10000 + increment=1000`)
  3. 测试强写 `state.endAtMs=1` 模拟到期
  4. 调用 `CloseAuction(ctx, aid)`
  5. 读取 snapshot 与 `ReadEventsAfter(ctx, aid, "")`
- **输入数据**
  - `Rules{StartPrice:10000, Increment:1000, Cap:0, Duration:60s}`
  - `clientBidId=cb1, amount=11000, userId=u1`
- **预期结果**
  - `CloseAuction` 返回 `OK_SOLD`,nil error
  - `snap.Status==SOLD, snap.WinnerID=="u1", snap.CurrentPriceCents=="11000"`
  - Stream 有 2 条:`[BID_ACCEPTED@1-0, AUCTION_SOLD@2-0]`,seq 严格递增 1 → 2
  - 之后任何 PlaceBid 返回 `ERR_NOT_LIVE`
- **优先级**:P0

### TC-T3-002 — Timer hammer LIVE 无出价 → NO_BID

- **前置条件**:LIVE 拍卖无任何出价,`seq=0`
- **测试步骤**:测试强写 `endAtMs=1`,调用 `CloseAuction`
- **输入数据**:无 bid 输入
- **预期结果**:返回 `OK_NO_BID`;status 变 `NO_BID`;Stream 有 `[AUCTION_NO_BID@1-0]`
- **优先级**:P0

### TC-T3-003 — 未到期 close → ERR_NOT_DUE

- **前置条件**:LIVE 拍卖,`endAtMs ≈ now + 60s`
- **测试步骤**:不修改 endAtMs,直接 `CloseAuction`
- **预期结果**:返回 `ERR_NOT_DUE` 且第二返回值 `endAtMs > 0` (允许 Timer 用此值刷新 ZSET score);status 仍 `LIVE`;Stream 无新 entry
- **优先级**:P0

### TC-T3-004 — terminal 状态再 close → ERR_ALREADY_TERMINAL

- **前置条件**:cap=50000 的 LIVE 拍卖,买家直接出价 50000 触发 cap-hit SOLD(T2 path)
- **测试步骤**:写 `endAtMs=1`,调用 `CloseAuction`
- **预期结果**:`ERR_ALREADY_TERMINAL`,无任何 HSET/XADD/PUBLISH
- **优先级**:P1

### TC-T3-005 — §4.1 hammer-race oracle (顺序版)

- **前置条件**:LIVE 拍卖,已有合法 bid `u1@11000`
- **测试步骤**:
  1. 写 `endAtMs=1` 模拟到期
  2. **顺序**:先 PlaceBid(`u2, 12000`),再 CloseAuction
- **预期结果**:
  - PlaceBid 返回 `ERR_AFTER_END`,seq=0 (无写入)
  - CloseAuction 返回 `OK_SOLD`,winner 仍是 `u1@11000`
  - Stream:`[BID_ACCEPTED@1, AUCTION_SOLD@2]`,无 `u2` 入账
- **优先级**:P0 (pinned oracle)

### TC-T3-006 — §4.1 hammer-race oracle (并发版,`-race` 下)

- **前置条件**:同 005,但 PlaceBid 与 CloseAuction 由两个 goroutine 同时启动 (start channel 释放)
- **预期结果**:
  - 不论 Redis 单线程化哪一脚本先执行,late bid 的 code ∈ {`ERR_AFTER_END`, `ERR_NOT_LIVE`} (永不 `OK_ACCEPTED`)
  - close 总是 `OK_SOLD`
  - 终态 snapshot 与 Stream 与 005 一致
- **优先级**:P0

### TC-T3-007 — LIVE 卖家 cancel → CANCELLED

- **前置条件**:LIVE 拍卖,owner=`sellerTestID`
- **测试步骤**:`CancelAuction(ctx, aid, sellerTestID)`
- **预期结果**:`OK_CANCELLED`;status=`CANCELLED`;Stream `[AUCTION_CANCELLED@1-0]`;后续 PlaceBid → `ERR_NOT_LIVE`
- **优先级**:P0

### TC-T3-008 — SCHEDULED 卖家 cancel

- **前置条件**:freeze 后未 start 的拍卖
- **预期结果**:`OK_CANCELLED`,Stream 单条 `AUCTION_CANCELLED@1-0` (freeze 不消耗 seq)
- **优先级**:P1

### TC-T3-009 — 非卖家 cancel

- **前置条件**:LIVE 拍卖,callerId=`not_the_seller`
- **预期结果**:`ERR_NOT_ALLOWED`,status 不变,无 Stream 写入
- **优先级**:P0

### TC-T3-010 — 已 terminal cancel

- **前置条件**:已经 cancel 过一次 (CANCELLED)
- **预期结果**:第二次 `ERR_ALREADY_TERMINAL`,无 Stream 写入
- **优先级**:P1

### TC-T3-011 — sellerId 空字符串 → fail-closed (CRITICAL 反例)

- **前置条件**:LIVE 拍卖,**手工 HSET sellerId=""** 模拟状态损坏
- **测试步骤**:`CancelAuction(ctx, aid, sellerTestID)`
- **预期结果**:返回 `ERR_NOT_ALLOWED`(必须 fail-closed,不可放行);status 仍 LIVE
- **历史**:旧 Lua 用 `if sellerId ~= '' and callerId ~= sellerId` 写法,空 sellerId 直接跳过检查 → 任何人都可 cancel。新 Lua `if not sellerId or sellerId == '' or callerId ~= sellerId` 修正
- **优先级**:P0

### TC-T3-012 — SCHEDULED close (Timer 误投递场景)

- **前置条件**:freeze 后未 start (status=SCHEDULED)
- **测试步骤**:调用 CloseAuction(ctx, aid)
- **预期结果**:`ERR_ALREADY_TERMINAL` (尽管 SCHEDULED 非终态,Lua 用此码表达 "非 LIVE,Timer 无须 retry");status 仍 SCHEDULED;Stream len=0
- **优先级**:P1

### TC-T3-013 — cancel 不是 hammer:有 winner 的 LIVE cancel 仍走 CANCELLED

- **前置条件**:LIVE 拍卖,已有 `u1@11000` 出价
- **测试步骤**:卖家 cancel
- **预期结果**:`OK_CANCELLED`(**非 OK_SOLD,买家不拿货**);最后一条 Stream event 是 `AUCTION_CANCELLED`;之后 bid 返回 `ERR_NOT_LIVE`
- **优先级**:P0 (产品语义关键)

### TC-T3-014 — seq 失配 preflight 不能 dirty-write

- **前置条件**:LIVE,无 bid (seq=0)
- **测试步骤**:
  1. 测试强写一个虚假 Stream entry `1-0` (`stream seq=1`,`state seq=0` → desync)
  2. 写 `endAtMs=1`
  3. 调用 CloseAuction
- **预期结果**:`ERR_INTERNAL{'seq_stream_mismatch'}`;**status 仍 LIVE,seq 仍 0**(HINCRBY 不能跑过)
- **意义**:Lua 无 rollback,preflight 是唯一防护
- **优先级**:P0

### TC-T3-015 — 错误 key 类型 (type guard)

- **前置条件**:测试用 `SET stateKey(aid) "corrupt"` 写入 String 类型
- **测试步骤**:close 与 cancel 各调用一次
- **预期结果**:两者都返回 `ERR_INTERNAL{'key_type'}`,不操作损坏 key
- **优先级**:P1

### TC-T3-016 — double hammer

- **前置条件**:LIVE,`u1@11000`
- **测试步骤**:
  1. 写 `endAtMs=1`
  2. 调用 CloseAuction → `OK_SOLD`
  3. 再次调用 CloseAuction
- **预期结果**:第二次 `ERR_ALREADY_TERMINAL`;seq 不动 (`snap2.Seq == snap1.Seq`);Stream len=2 (BID_ACCEPTED + 一条 AUCTION_SOLD,无重复)
- **优先级**:P0 (Timer 双触发 / 多实例并发场景)

### TC-T3-017 — reconcile 自愈 lost LIVE auction (CRITICAL)

- **前置条件**:freeze + start LIVE 拍卖 `live_aid` (TrackActive 已成功);另起一个 freeze-only `sched_aid`
- **测试步骤**:
  1. 测试 `UntrackActive(ctx, live_aid)` 模拟 TrackActive 失败的最终状态
  2. 直接调用 `reconcileActive(ctx, st)`
  3. 用一个超大 score 查询 `DueAuctions` 看 `live_aid` 是否回到 ZSET
- **预期结果**:
  - `live_aid` 在 ZSET 中存在 (reconcile 重新跟踪)
  - `sched_aid` **不在** ZSET 中 (非 LIVE 状态不跟踪)
- **意义**:这是 PR #29 自检中加的 CRITICAL 自愈 — 在没有这个 reconcile 的旧实现里,TrackActive 失败 = 拍卖永远没人 hammer
- **优先级**:P0

### TC-T3-018 — E2E Timer hammer 全链路

- **前置条件**:in-process harness 启动 (Redis + MySQL + hub + persistence + timer)
- **测试步骤**:
  1. seller devLogin + createProduct + createAuction (`durationMs=1500`)
  2. freeze + start
  3. buyer devLogin,dial WS,ROOM_JOIN
  4. 发 `BID_PLACE{cb=cbT3, amount=11000}`
  5. 等待 `BID_ACCEPTED`
  6. 等待 Timer 触发 → 接收 `AUCTION_SOLD`
  7. 轮询 GET /api/auctions/{aid} 直到 status=SOLD
- **输入数据**:`rules{StartPrice:10000, Increment:1000, Cap:1000000, Duration:60, ExtendWindow:0}` (重要:`ExtendWindow=0` 避免 anti-snipe 延长 endAtMs)
- **预期结果**:
  - BID_ACCEPTED 在 5s 内收到
  - AUCTION_SOLD 在 5s 内收到 (Timer 100ms scan, 1.5s 后触发)
  - MySQL status 在 5s 内变 SOLD
- **优先级**:P0 (E2E,涵盖 broadcast + persistence projection)

### TC-T3-019 — E2E LIVE cancel REST

- **前置条件**:同 018,但 duration=60s,不出价
- **测试步骤**:
  1. seller freeze + start
  2. buyer dial WS
  3. seller POST /api/auctions/{aid}/cancel
  4. buyer 等待 `AUCTION_CANCELLED`
  5. 轮询 MySQL status=CANCELLED
- **预期结果**:REST 返回 OK_CANCELLED;buyer 在 5s 内收到 AUCTION_CANCELLED;MySQL 在 5s 内变 CANCELLED
- **优先级**:P0

### TC-T3-020 — E2E DRAFT cancel + 非卖家 + 重复

- **前置条件**:DRAFT 拍卖 (createAuction 后未 freeze)
- **测试步骤**:
  1. other seller cancel → 期望 403
  2. owner seller cancel → 期望 OK_CANCELLED (MySQL-only flip)
  3. 轮询 MySQL status=CANCELLED
  4. owner 再 cancel 一次 → 期望 409 ERR_ALREADY_TERMINAL
- **预期结果**:状态码与 wire code 严格匹配
- **优先级**:P1

---

## 2. 缺口型用例 (本 review 主张补测)

### TC-T3-100 — DRAFT cancel 与 freeze 并发 → MySQL/Redis 分裂?

- **前置条件**:刚 createAuction 的 DRAFT 拍卖 `aid`,owner=A
- **测试步骤**:
  1. 起两个 goroutine:G1 = `POST /freeze` (走 freeze_rules.lua,Redis 写 SCHEDULED state),G2 = `POST /cancel`
  2. 同时释放
  3. 检查 Redis state.status 与 MySQL auctions.status
- **可能交错**:
  - **(a)** G2 cancel 抢先读 MySQL → DRAFT,走 MySQL-only 分支 → MySQL CANCELLED。**之后** G1 freeze 写 Redis SCHEDULED。最终:**MySQL=CANCELLED, Redis state.status=SCHEDULED — 状态分裂**
  - **(b)** G1 先完成 → MySQL SCHEDULED → G2 走 Lua 分支 cancel → OK
- **预期结果(我主张)**:
  - 任一交错下,Redis 与 MySQL 终态必须一致
  - 当前实现下交错 (a) 会出现分裂 — 建议 `handleCancel` 在 DRAFT 分支前用 SELECT…FOR UPDATE 或重新读取最新状态
- **复现难度**:需要同 seller 在毫秒级触发 freeze+cancel;实战极罕见但 TOCTOU 真实存在
- **优先级**:P1

### TC-T3-101 — cancel.lua 成功但 MySQL update 失败的最终一致性

- **前置条件**:LIVE 拍卖;mock 或注入 MySQL 失败 (e.g. `UPDATE auctions SET status=...` 在执行时关库)
- **测试步骤**:
  1. seller POST /cancel
  2. cancel.lua 成功 → Redis CANCELLED + Stream AUCTION_CANCELLED + Pub
  3. UntrackActive 假设成功
  4. UpdateAuctionStatus 失败 → handler 返回 500 给客户端
  5. **重新启用 MySQL**,等待 persistence sweep (2s tick)
  6. 查询 MySQL `auctions.status`
- **预期结果**:persistence worker 把 AUCTION_CANCELLED 事件投影成 MySQL CANCELLED。**最终一致**
- **意义**:dev-log 里 Eliaaazzz 论证"INSERT IGNORE 幂等 + cursor 仅在两者都成功后推进,所以投影最终一致" — 需要一个测试真正证实这一点
- **优先级**:P1

### TC-T3-102 — 短拍卖 (<5s) 与 TrackActive 失败的窗口期

- **前置条件**:durationMs=2000 的拍卖;mock `TrackActive` 第一次失败 (注入 ZADD 错误)
- **测试步骤**:
  1. freeze + start (start 返回 OK_LIVE,TrackActive 失败,start 仍返回 200)
  2. 不出价,等待自然到期 (~2s)
  3. 期间:Timer 100ms scan 看不到这个 auction (不在索引)
  4. reconcile 在 5s 时才跑 → 重新加入索引 → 立即 hammer (now > endAtMs)
- **预期结果(我主张)**:auction 终会 hammer (NO_BID),但**延迟 3-5s**(超过拍卖本身的窗口)。需文档化这是 acceptable
- **意义**:reconcile 5s 间隔是一个 SLO,文档应说明 "TrackActive 失败时,hammer 最多延迟 reconcile interval";否则用户会以为"拍卖准时结束"
- **优先级**:P2

### TC-T3-103 — 双 Timer 同 auction 并发 close

- **前置条件**:启动两份 lumen 进程 (`--mode=all` + 额外 `--mode=timer`),都连同一 Redis
- **测试步骤**:
  1. 创建一个 LIVE 拍卖,设 `endAtMs=1` 触发立即 due
  2. 让两个 Timer 在同一 scan 周期都看到该 auction (同 1ms 内)
  3. 观察 Stream + state
- **预期结果**:
  - 一个 Timer 拿 OK_SOLD/NO_BID,另一个拿 ERR_ALREADY_TERMINAL → 都 untrack
  - Stream 仅一条终态 event
  - 两个 Timer 的 untrack ZREM 幂等
- **意义**:dev-log 声明 "Redis 单线程化 Lua 脚本所以无害",需 e2e 验证而非仅论证
- **优先级**:P2

### TC-T3-104 — Timer 在 ERR_INTERNAL 下的无限重试

- **前置条件**:LIVE 拍卖,人为制造 `seq_stream_mismatch`(测试写脏 Stream entry)
- **测试步骤**:
  1. close.lua 返回 ERR_INTERNAL
  2. 观察 timer.go::hammerDue 的 `switch`(只覆盖 OKSold/OKNoBid/ErrAlreadyTerminal/ErrNotDue)
  3. 看 Timer 后续 5 个 scan tick (500ms)
- **预期结果**:**Timer 每 100ms 调用一次 close.lua 都拿 ERR_INTERNAL,既不 untrack 也不 backoff**。日志洪水,无收敛路径
- **建议修复**:
  - 加 ERR_INTERNAL 计数,N 次后 untrack 并 emit alarm
  - 或加抖动 backoff
- **优先级**:P2 (生产事故时会喷日志,但不会造成数据错误)

### TC-T3-105 — cancel 与 timer hammer 并发

- **前置条件**:LIVE 拍卖,`u1@11000`,endAtMs 即将到期
- **测试步骤**:
  1. 在 endAtMs 时刻同时 (并发 goroutine) 发起:G1=seller cancel REST,G2=Timer scan + close
  2. 检查终态
- **预期结果(无论交错)**:
  - 终态 ∈ {`SOLD`, `CANCELLED`}
  - Stream 恰好一条终态 event (`AUCTION_SOLD` 或 `AUCTION_CANCELLED`)
  - 失败的一方在 Lua 拿 `ERR_ALREADY_TERMINAL`
  - MySQL 投影与 Redis state.status 一致
- **意义**:产品语义层面 "cancel 还是 hammer 谁赢"对卖家结果不同 (SOLD 收款 vs CANCELLED 不收) — 需文档化"谁先到 Redis 谁赢" 是接受的设计
- **优先级**:P1

### TC-T3-106 — reconcile scan 在高 LIVE 拍卖密度下的成本

- **前置条件**:Redis 注入 10K LIVE 拍卖 state hash
- **测试步骤**:
  1. 调用 `reconcileActive(ctx, st)`
  2. 测 wall time + Redis 命令数
- **预期结果(我主张的预算)**:p95 < 200ms(reconcile interval 5s,占比 < 4%)
- **意义**:`ScanStateAIDs` 用 COUNT=200 的 SCAN + 对每个 aid 调 `Snapshot`(HGETALL)。10K auctions ≈ 50 次 SCAN + 10K HGETALL → 单线程 Redis 上可能耗几百 ms。T8 perf 风险点
- **优先级**:P2 (T8 时必须验证)

### TC-T3-107 — 重启 mid-cancel 时 persistence 是否补齐 MySQL

- **前置条件**:LIVE 拍卖,触发一次 cancel 后**立即** SIGKILL lumen 进程,在 persistence worker 还没投影前
- **测试步骤**:
  1. seller cancel → cancel.lua 成功,Stream 有 AUCTION_CANCELLED@2-0(or 1-0),MySQL **仍 LIVE**(persistence 还没跑)
  2. SIGKILL lumen
  3. 重启 lumen
  4. 等待 persistence 初始 sweep
  5. 查 MySQL status
- **预期结果**:重启后 MySQL 在 ~2s 内变 CANCELLED(初始 sweep 把所有 Stream 拉一遍,terminalStatus() 投影)
- **意义**:Stream-first 设计的关键 invariant — Pub/Sub 丢消息也不丢状态。Dev-log 论证了,需测试证实
- **优先级**:P1

---

## 3. 执行计划

- **覆盖型 (TC-T3-001..020)**:本 PR 已实现 20 个 `_test.go` (16 store + 4 server),执行 `go test -race -count=1 ./apps/lumen/internal/store/... ./apps/lumen/internal/server/...` 即可
- **缺口型 (TC-T3-100..107)**:
  - **TC-T3-101 已落地** — PR #31 commit `8a4ac02` 加了 `TestT3CancelEventualConsistencyFromStream` (handleCancel 返 200 + persistence worker 自愈,Stream-first 设计的回归测)
  - 100 (DRAFT TOCTOU) + 105 (cancel vs hammer concurrency winner) + 107 (重启 mid-cancel) 建议在 [#32 T3 follow-up](https://github.com/Eliaaazzz/live-auction-system/issues/32) PR 落地
  - 102, 103, 104, 106 文档化为 known-gap,T5/T8 时回过来补

## 4. 评审历史

- v1 (2026-05-25, @fariZzzz) — 初稿,基于 commit `24a2151`,base chain 仍为 T2 stranded
- v2 (2026-05-25, @fariZzzz) — Eliaaazzz CR fix: coverage count 15→20 (16 store + 4 server `_test.go`); TC-T3-101 marked 已落地 (PR #31 `8a4ac02` adopted the eventual-consistency design); links updated for rollup PR #31 + follow-up issue #32
