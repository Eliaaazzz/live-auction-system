# T4 测试用例 — Persistence Hash Chain + Idempotent Order + Evidence Card (PR #34)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T4-persistence-order-evidence` — v1 drafted against `8b27ccc`; **v2 reflects `8d8fa16`** (@PDGGK "harden T4 evidence projection"); **v3 reflects the second-pass review** (`b72a60e` + the TC-T4-112 P0 fix in PR #47). Based on `main` (post T1+T2+T3 rollups).
> Authored **before** the substantive PR #34 review per the team's "test cases first" precedent from T3 (PR #30 → CI tests in PR #33). **状态**:我 v1 的 5 个 P0/P1 缺口 (100/101/102/104/107) 被 `8d8fa16` 全部 patch;v3 第二轮又抓到一个 **P0 假证据** (TC-T4-112) — review→fix 闭环持续。
> Executable probes: TC-T4-110 → **#45** (merged into #34); **TC-T4-112 → #47** (stacked on #34, the seq-contiguity fix + test).
>
> **`8d8fa16` 架构变更(影响多条用例)**:evidence card 的 summary 字段 (`status`/`currentPriceCents`/`winnerId`/`seq`) 从 **live Redis snapshot** 改为 **从持久化 hash 链 + order 派生**(新纯函数 `evidenceSummary`);`/evidence` 端点加 **auth gate**(401);SOLD 投影改为 3 步 `projectSold`(status→SOLD,建 order,status→ORDER_CREATED)+ **poison taxonomy**(`ErrPermanentOrderProjection`/`ErrOrderProjectionMismatch` 推进 cursor 不死循环;`ErrPreviousEventHashMissing` 是 transient retry);`fillEventHash` 加 `FOR UPDATE` 事务;`InsertEvent` 现在也查 `event_type` mismatch。
>
> Schema (per @fariZzzz 5/25 directive):每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`. 用例分两类:
> - **覆盖型 (Coverage, TC-T4-001…011)** — 对应 PR #34 现有 `_test.go` 用例(v2 = 10 个落地)+ 合约级用例
> - **缺口型 (Gap probes, TC-T4-100…111)** — 架构推理出的边界场景;v2 把已 patch 的标 RESOLVED,新加 110/111
>
> 优先级:**P0** 系统不可用 / 假证据 / 状态分裂 · **P1** 关键路径功能错误 · **P2** 自愈但可观测性差 · **P3** 极端/罕见 / 性能
>
> 注:hash 算法 = `HMAC_SHA256(key, prev || "\n" || dec(seq) || "\n" || event_type || "\n" || payload_json_normalized)`;genesis `prev=""`;`payload_json_normalized` = MySQL 读回后的形式(MySQL JSON 列归一化 key 顺序/whitespace)。`EVIDENCE_HMAC_KEY` 默认 `"change-me-evidence-local-only"`,生产环境必须改。

---

## 0. 用例索引

### 覆盖型 (11)

| ID | 标题 | 对应 PR #34 测试 (`8d8fa16`) | P |
|---|---|---|---|
| TC-T4-001 | genesis prev_hash 空,链接正确,VerifyEvidenceChain 通过 | `TestT4HashChainGenesisLinkAndVerify` | P0 |
| TC-T4-002 | 重复 InsertEvent 同 (aid, seq, payload) → 无重复行,event_hash 不变 | `TestT4HashChainIdempotentReprojection` | P0 |
| TC-T4-003 | 后改 payload_json → VerifyEvidenceChain 失败,hash_break_at_seq = 改动位置 | `TestT4HashChainTamperBreaksAtSeq` | P0 |
| TC-T4-004 | AUCTION_SOLD 重复投影 → 仅一个 orders 行 + 冲突 payload → `ErrOrderProjectionMismatch` | `TestT4OrderIdempotentOnSold` (v2 含 mismatch 断言) | P0 |
| TC-T4-005 | E2E:Timer hammer → AUCTION_SOLD → evidence card 链 verified + order 存在 | `TestT4EvidenceAfterHammer` | P0 |
| TC-T4-006 | 同 (aid, seq) 不同 **event_type 或** payload → ErrEventPayloadMismatch | `8d8fa16` InsertEvent 加 type-check(隐含;TC-T4-110 旁证) | P0 |
| TC-T4-007 | `lumen verify-evidence` 链 OK → exit 0 | (隐含在 RunVerifyEvidence;未独立测) | P1 |
| TC-T4-008 | `lumen verify-evidence` 链 BROKEN → exit ≠ 0,日志含 `hash_break_at_seq=N` | (未测) | P1 |
| TC-T4-009 | EVIDENCE_HMAC_KEY 在 `APP_ENV != dev` 用默认值 → config.Load 失败 | (`config_test.go`) | P0 |
| TC-T4-010 | /evidence schema 与 proto 一致 + chainVerified=true 时无 hashBreakAtSeq | (隐含在 TC-T4-005) | P1 |
| TC-T4-011 | SOLD 3 步投影最终 status=ORDER_CREATED;missing-auction SOLD = 永久 poison | `TestT4ProjectSoldPromotesOrderCreated` + `TestT4ProjectSoldMissingAuctionIsPermanent` | P0 |

### 缺口型 (13) — v2/v3 状态映射(我 v1 的 5 个 P0/P1 被 `8d8fa16` 闭环;v3 + 第二轮 P0)

| ID | 标题 | v2 状态 (`8d8fa16`) | P |
|---|---|---|---|
| TC-T4-100 | 删除中间一行 auction_events,VerifyEvidenceChain 在下一行就 break | **✅ FIXED** — `TestT4HashChainDeletionBreaksAtSeq` 落地(running head vs prev_hash mismatch) | P0 (resolved) |
| TC-T4-101 | 双 worker 并发 fillEventHash 算错 prev(seq+2 看到 seq+1 未链化 → 误判 genesis) | **✅ FIXED** — `fillEventHash` 改事务 + `SELECT … FOR UPDATE`;seq>1 但 prev 未链化 → `ErrPreviousEventHashMissing` transient retry,不会写错 hash | P1 (resolved) |
| TC-T4-102 | 持久化在 INSERT 与 fillEventHash 之间崩溃 → 重启后链自愈 | **✅ FIXED** — `TestT4HashFillWaitsForPreviousHash` 验证未链化再投影会重算 + 等 prev | P1 (resolved) |
| TC-T4-103 | 多 worker 同 fillEventHash 同一行 idempotent | **✅ 实质 FIXED** — `FOR UPDATE` 串行化 + `UPDATE WHERE event_hash IS NULL` no-op,单测仍可补 | P1 (resolved) |
| TC-T4-104 | AUCTION_SOLD 空 winnerId → 无限重试卡住 worker(我 v1 的核心担忧) | **✅ FIXED** — poison taxonomy:`ErrPermanentOrderProjection`(空 winnerId / 坏 payload / 缺 auction 行)+ `ErrOrderProjectionMismatch` → worker `lastID[aid]=e.ID; continue` 推进 cursor,**不再死循环**。链 + 行仍插入(证据完整) | P1 (resolved) |
| TC-T4-105 | EVIDENCE_HMAC_KEY 轮换 → pre-rotation 行验证失败 | 仍 open — issue #37 跟踪(key rotation/MySQL-upgrade P3) | P2 |
| TC-T4-106 | /evidence 在 10K event 链上的延迟(单次 VerifyEvidenceChain) | 仍 open — issue #37 跟踪(VerifyEvidenceChain caching P2);auth gate 已降低公共 DoS 面 | P2 |
| TC-T4-107 | /evidence 暴露 buyerId 给未认证调用者(无 auth gate) | **✅ FIXED** — `handleEvidence` 加 `s.authUser(r)` → 401;`TestT4EvidenceRequiresAuth` 落地 | P1 (resolved) |
| TC-T4-108 | MySQL JSON 归一化跨版本差异 → 旧链校验失败 | 仍 open — issue #37(MySQL-upgrade P3) | P3 |
| TC-T4-109 | 极短拍卖 AUCTION_SOLD 未投影时 /evidence(最终一致性窗口) | 仍 open — 文档化议题,TC-T4-005 用 8s deadline 隐式 mitigate | P3 |
| TC-T4-110 | evidenceSummary 从链派生 status/price/winner(NO_BID/CANCELLED/LIVE/SOLD/order-override) | **✅ EXECUTABLE in PR #45** — `TestT4EvidenceSummaryDerivesFromChain`,5 表驱动 case。验证 `8d8fa16` 把 evidence 读路径从 Redis 迁到链。本地 PASS | P1 |
| TC-T4-111 | CANCELLED 拍卖的 evidence card 仍带最后一笔 bid 的 winnerId/price(语义) | **✅ FIXED in `b72a60e`**(@Eliaaazzz 采纳)— `evidenceSummary` 的 CANCELLED 分支现在清空 winner/price。v1 由 PR #45 probe 发现 | P3 (resolved) |
| TC-T4-112 | **projection-time seq SKIP** → 链 1→3 仍 verify(漏检 dropped event,假证据) | **🔴→✅ FIXED in PR #47** — 第二轮 review(@Eliaaazzz #35 CR)发现:`fillEventHash` 链到"最高的 seq < N"而非恰好 `seq-1`,且 `VerifyEvidenceChain` 不查连续性 → `InsertEvent(1)` then `InsertEvent(3)` 链成 1→3 且通过验证。两层修复 + `TestT4SeqSkipDoesNotChainOrVerify` 落地 | **P0** |

---

## 1. 覆盖型用例

### TC-T4-001 — genesis prev_hash 空 + 链接 + 验证

- **前置条件**: MySQL 已迁移到含 `event_hash`/`prev_hash` 列;EVIDENCE_HMAC_KEY 已 load;auction_events 为空
- **测试步骤**:
  1. `InsertEvent(aid, seq=1, BID_ACCEPTED, payload1)` → row + fillEventHash
  2. `InsertEvent(aid, seq=2, AUCTION_SOLD, payload2)`
  3. `EventTimeline(aid)` 读回 timeline
  4. `VerifyEvidenceChain(aid)`
- **输入数据**:
  - payload1 = `{"seq":1,"userId":"u1","amountCents":"11000"}`
  - payload2 = `{"seq":2,"winnerId":"u1","amountCents":"11000","status":"SOLD"}`
- **预期结果**:
  - `tl[0].PrevHash == ""`(genesis)
  - `tl[0].EventHash != ""`, `tl[1].EventHash != ""`
  - `tl[1].PrevHash == tl[0].EventHash`(链接)
  - VerifyEvidenceChain 返回 `(ok=true, break=0, nil)`
- **优先级**: P0

### TC-T4-002 — 同 (aid, seq, payload) 重复投影 → idempotent

- **前置条件**: TC-T4-001 已建链
- **测试步骤**:
  1. 同 seq + 同 payload 再次 InsertEvent
  2. CountEvents
  3. EventTimeline 再读
  4. VerifyEvidenceChain
- **预期结果**:
  - CountEvents 仍为 1
  - timeline[0].EventHash 不变
  - 链仍 verify
- **意义**: persistence worker 的 Stream-first sweep 设计依赖 INSERT IGNORE + fillEventHash 的 idempotency
- **优先级**: P0

### TC-T4-003 — 后改 payload_json → 在改动 seq 处 break

- **前置条件**: 链已建,3 条 BID_ACCEPTED
- **测试步骤**:
  1. VerifyEvidenceChain 应 ok=true(前置)
  2. 直接 SQL `UPDATE auction_events SET payload_json=... WHERE seq=2`
  3. VerifyEvidenceChain
- **预期结果**: `(ok=false, break=2, nil)`(在改动的 seq 处 break,**不是**后续)
- **意义**: 这是 T4 hash chain 防御的核心威胁
- **优先级**: P0

### TC-T4-004 — 同 AUCTION_SOLD 重复 → 仅一 orders 行

- **前置条件**: products + auctions 行存在
- **测试步骤**:
  1. `CreateOrderFromSold(aid, sold_payload)`
  2. GetOrder 读回
  3. 重复 CreateOrderFromSold(同 payload)
  4. `SELECT COUNT(*) FROM orders WHERE auction_id=?`
- **输入数据**: payload `{"seq":2,"winnerId":"buyer_t4","amountCents":"11000","status":"SOLD"}`
- **预期结果**:
  - GetOrder: `buyerId=buyer_t4, amountCents=11000, productId=正确`
  - count == 1(UNIQUE(auction_id) + INSERT IGNORE)
- **优先级**: P0

### TC-T4-005 — E2E hammer → evidence card verified + order

- **前置条件**: full server stack (Redis+MySQL+hub+timer+persistence worker)
- **测试步骤**:
  1. seller create + freeze + start(`durationMs=1500`)
  2. buyer dial WS + 出价 `11000`
  3. 等 BID_ACCEPTED
  4. 等 AUCTION_SOLD(Timer 1.5s 后 hammer)
  5. 轮询 GET /api/auctions/{aid}/evidence(8s deadline,因为 persistence 异步)
- **预期结果**:
  - chainVerified == true
  - eventsHash 非空
  - order.buyerId == buyer.userId
  - order.amountCents == "11000"
- **优先级**: P0(关键 E2E)

### TC-T4-006 — 同 (aid, seq) 不同 payload → ErrEventPayloadMismatch

- **前置条件**: 已有 seq=5, payload=`{"a":1}`
- **测试步骤**:
  1. `InsertEvent(aid, 5, BID_ACCEPTED, '{"a":2}')`
- **预期结果**: 返回 `ErrEventPayloadMismatch`,**链不变**(链未 advance,row 也未更新)
- **意义**: tamper/bug tripwire on the projection layer
- **优先级**: P0

### TC-T4-007 — verify-evidence CLI 链 OK → exit 0

- **前置条件**: TC-T4-001 setup
- **测试步骤**: `lumen verify-evidence --auction <aid>`
- **预期结果**: stdout `evidence chain consistent: events=N`;exit 0
- **优先级**: P1

### TC-T4-008 — verify-evidence CLI 链 BROKEN → exit ≠ 0

- **前置条件**: TC-T4-003 setup(已 tamper)
- **测试步骤**: `lumen verify-evidence --auction <aid>`
- **预期结果**: stderr `evidence chain BROKEN: hash_break_at_seq=2`;exit ≠ 0
- **优先级**: P1
- **当前状态**: PR #34 没有单元测试覆盖 CLI 出口码。CI `make verify-evidence` gate 应该跑过(empty chain ok)

### TC-T4-009 — EVIDENCE_HMAC_KEY 默认值在 prod env 失败

- **前置条件**: 干净 env
- **测试步骤**:
  1. `APP_ENV=production EVIDENCE_HMAC_KEY=change-me-evidence-local-only` → config.Load
  2. `APP_ENV=production EVIDENCE_HMAC_KEY=` → config.Load
  3. `APP_ENV=production EVIDENCE_HMAC_KEY=<real-value>` + JWT_SECRET=<real> + ENABLE_DEV_LOGIN=false → config.Load
- **预期结果**:
  - (1) 错误 `EVIDENCE_HMAC_KEY must be set to a non-default value when APP_ENV="production"`
  - (2) 同上
  - (3) 成功
- **优先级**: P0(prod 启动安全)

### TC-T4-010 — /evidence 返回 schema 匹配 proto/evidence-card.md

- **前置条件**: TC-T4-005 已完成
- **测试步骤**:
  1. `curl /api/auctions/{aid}/evidence | jq`
  2. 检查 keys: auctionId, status, currentPriceCents, winnerId, seq, eventsCount, factsConfirmed, timeline, eventsHash, chainVerified, note
  3. 检查 chain BROKEN 时 hashBreakAtSeq 存在
  4. 检查 order 仅在 sold 时存在
- **预期结果**: schema 严格匹配 proto;chainVerified=true 时 hashBreakAtSeq 字段缺席(不是 null)
- **优先级**: P1

---

## 2. 缺口型用例

### TC-T4-100 — 删除中间一行,链应在下一行 break

> **v2 (`8d8fa16`): ✅ FIXED** — `TestT4HashChainDeletionBreaksAtSeq` 落地。以下为 v1 分析。

- **前置条件**: 3 条事件已链化(TC-T4-001 扩展)
- **测试步骤**:
  1. VerifyEvidenceChain 前置 ok
  2. `DELETE FROM auction_events WHERE auction_id=? AND seq=2`
  3. VerifyEvidenceChain
- **预期结果**: `(ok=false, break=3, nil)`(seq=3 的 prev_hash 指向 seq=2 的 event_hash,但 running head 是 seq=1 的 event_hash → mismatch)
- **意义**: 漏报会导致 partial evidence 通过 verify,假证据风险
- **是否已测**: ❌ — PR #34 只测了 payload 篡改,**没有测删除**

### TC-T4-101 — 双 persistence worker 并发 InsertEvent 链生成

> **v2 (`8d8fa16`): ✅ FIXED** — `fillEventHash` 改事务 + `SELECT … FOR UPDATE`;prev 未链化时返 `ErrPreviousEventHashMissing`(transient retry),不会用空 prev 误算 genesis。以下为 v1 分析。

- **前置条件**: `--mode=all` + `--mode=pg-writer` 同时跑,同 MySQL
- **场景**: 两个 worker 同时投影 seq=N+1
- **可能交错**:
  - W1: INSERT IGNORE 成功,fillEventHash(SELECT payload, SELECT prev → 看到 seq=N 的 event_hash,compute h, UPDATE)
  - W2: INSERT IGNORE no-op(行已存在),进入 payload-diff 检查(payload 相同 → ok),也调用 fillEventHash
  - W2 的 fillEventHash: SELECT payload, SELECT prev(此时 W1 可能还没 UPDATE seq=N+1) → 看到 seq=N → compute h(同 W1),UPDATE WHERE event_hash IS NULL
  - 第一个 UPDATE 赢(WHERE 条件),第二个 no-op ✓ idempotent
- **但**:如果 W1 还没完 fillEventHash(seq=N+1),W2 就开始投影 seq=N+2:
  - W2.fillEventHash(seq=N+2).SELECT prev → 看到 seq=N+1 的 prev_hash 还是 NULL → `prev.String == ""` → genesis!
  - 这会计算错误的 hash(因为 prev 应该是 seq=N 的 event_hash,不是空)
  - 然后 UPDATE seq=N+2 WHERE event_hash IS NULL → 写入错误的 hash
  - 后续 W2 投影 seq=N+1 时 fillEventHash 会发现 existing.Valid == true → skip
  - **结果**: seq=N+1 hash 是对的(W1 算的),seq=N+2 hash 是错的(W2 算错的 prev)
  - VerifyEvidenceChain 在 seq=N+2 报 break(prev mismatch)→ **正确检测**,但是 **假阳性**(数据本身没被篡改,只是写入时机错)
- **预期结果**: 这是设计弱点。单 worker 部署下不会发生(seq 顺序投影)。多 worker 部署需要锁或基于 prev_hash 的乐观并发控制
- **建议**: 文档化 "single persistence worker is required" OR 加 SELECT prev … FOR UPDATE
- **优先级**: P1
- **是否已测**: ❌

### TC-T4-102 — 持久化崩溃在 INSERT 与 fillEventHash 之间

> **v2 (`8d8fa16`): ✅ FIXED** — `TestT4HashFillWaitsForPreviousHash` 验证未链化行再投影会重算 + 等 prev 链化。以下为 v1 分析。

- **前置条件**: mock InsertEvent 部分成功(INSERT 完成,fillEventHash 失败)
- **测试步骤**:
  1. INSERT 行,event_hash IS NULL
  2. 模拟进程崩溃 → 重启 persistence worker
  3. worker 再次 sweep → ReadEventsAfter 看到这个 Stream event,InsertEvent 再次跑
  4. INSERT IGNORE no-op,fillEventHash 被调用(因为 InsertEvent 总是 call fillEventHash)
  5. fillEventHash 看到 existing IS NULL → 重新计算 + UPDATE
- **预期结果**: 自愈 — 重启后链被填充
- **意义**: 这是 PR #34 body 声明的关键自愈不变量,需测试证实
- **优先级**: P1
- **是否已测**: ❌ — TC-T4-002 测的是 "已链化后再投影 = no-op",**不**是 "未链化再投影 = 链化"。值得加。

### TC-T4-103 — 多 worker 同 fillEventHash 同一行 idempotent

- **前置条件**: 同 TC-T4-101
- **测试步骤**: 两个 goroutine 同时调用 fillEventHash(aid, seq, eventType)
- **预期结果**: 一个 UPDATE WHERE event_hash IS NULL 赢,另一个 affected rows=0,no-op。最终 event_hash 唯一
- **优先级**: P1
- **是否已测**: ❌(单点 idempotency 在 TC-T4-002 测了,**并发** idempotency 没测)

### TC-T4-104 — AUCTION_SOLD payload winnerId 空 → 链 advance 但 order 失败

> **v2 (`8d8fa16`): ✅ FIXED**(我 v1 的核心担忧)— poison taxonomy:空 winnerId → `ErrPermanentOrderProjection`,worker `lastID[aid]=e.ID; continue` 推进 cursor 不再无限重试,后续 auction 不被卡。链 + 行仍插入(证据完整)。`TestT4ProjectSoldMissingAuctionIsPermanent` 覆盖 missing-auction 那类 poison;空-winnerId 类 worker-advance 仍可补一个 e2e(见下 v1 分析)。以下为 v1 分析。

- **前置条件**: AUCTION_SOLD payload = `{"seq":2,"winnerId":"","amountCents":"11000","status":"SOLD"}`
- **测试步骤**:
  1. persistence worker 处理这个事件:
     - InsertEvent → row + fillEventHash ✓
     - UpdateAuctionStatus(SOLD) ✓
     - CreateOrderFromSold → 返回错误 `"empty winnerId"`
     - **`break` from the for loop** → cursor 不 advance
  2. 下一次 sweep 再来一次:
     - InsertEvent → no-op(已存在)
     - UpdateAuctionStatus → no-op(已 SOLD)
     - CreateOrderFromSold → 又失败
- **预期结果**: 链 + status 已正确,orders 永远没建。重试无限循环。
- **可能后果**: 持久化 worker 卡在这个 auction,后面所有 Stream 事件不投影
- **意义**: 真正的 AUCTION_SOLD 不应该有空 winnerId(close_auction.lua 在 `winner == ''` 时走 NO_BID 分支),所以这是 corrupt-state 场景。但 worker 应该有 fail-fast OR skip-and-alert 路径,而不是无限重试。
- **优先级**: P1
- **是否已测**: ❌

### TC-T4-105 — EVIDENCE_HMAC_KEY 轮换 → pre-rotation 行验证失败

- **场景**: 生产部署使用 KMS key A 一段时间,然后轮换到 key B
- **预期行为**: 用 key B 校验 key A 链化的行 → mismatch → hash_break_at_seq=1
- **当前设计**: doc(evidence-card.md §3)说 "Rotation: changing the key invalidates recompute of pre-rotation rows; deferred". 已知限制
- **建议补**: 在 storedb.go 加 schema column `hmac_key_version` (smallint default 1),verify 时按 row 查对应 key。或文档化 "rotation = re-chain all rows + bump key_version + drop old"
- **优先级**: P2
- **是否已测**: 不需要测,但文档应明确 prod 操作

### TC-T4-106 — /evidence 性能在 10K 事件链

- **前置条件**: 注入 10K auction_events 行(单 auction)
- **测试步骤**: `time curl /api/auctions/{aid}/evidence > /dev/null`
- **预期结果**(预算): p95 < 1s for 10K events
- **现在的实现**: VerifyEvidenceChain 全表扫 + 10K HMAC computation → 估 200ms 不止
- **DoS 风险**: 公共端点,无 rate limit,无 cache
- **建议**: cache chain head + verified-up-to-seq;只 verify 新增部分。或加 auth gate(见 TC-T4-107)
- **优先级**: P2(T8 perf 议题)
- **是否已测**: ❌

### TC-T4-107 — /evidence 公共暴露 buyerId

> **v2 (`8d8fa16`): ✅ FIXED** — `handleEvidence` 开头加 `s.authUser(r)` 检查 → 未认证 401;`TestT4EvidenceRequiresAuth` 落地。以下为 v1 分析。

- **前置条件**: sold auction
- **测试步骤**:
  1. 不带 token,直接 `curl /api/auctions/{aid}/evidence`
  2. 检查 `.order.buyerId` 是否在响应中
- **预期结果**: 当前实现 → 是的,buyerId 暴露给任何调用者
- **意义**:
  - winnerId 在 room snapshot 也是 public(comment 已注明),OK
  - 但 **buyerId in orders.buyer_id** 是不同字段语义吗?如果跟 winnerId 是同一人,那暴露与现状一致。如果将来 buyerId 可以是非 bidder(代付场景?),就暴露过头了
  - 当前 T4 实现里 buyerId = winnerId from AUCTION_SOLD payload,所以等价
- **建议**: 加 comment 说 "intentionally public, equivalent to room snapshot's winnerId; if buyerId ever diverges, gate this endpoint"
- **优先级**: P1(隐私 baseline)
- **是否已测**: ❌

### TC-T4-108 — MySQL JSON 归一化跨版本差异

- **场景**: 部署 MySQL 8.0.30,链化 1000 events。升级 MySQL 8.0.35,再次 verify。MySQL 实现可能换了 JSON 序列化算法
- **当前防御**: doc 说 "hashes the read-back form, so both writer and verifier agree on one deployment" — 升级不保证
- **历史先例**: MySQL 8.0.x 间确实有 JSON 实现变更(8.0.13 加了 JSON_TABLE,8.0.17 改了 JSON_VALUE)
- **建议**: doc 加 "upgrade may invalidate hashes; rechain via offline tool" + 加 schema column `mysql_version` for diagnostic
- **优先级**: P3(长期)
- **是否已测**: ❌

### TC-T4-109 — 极短拍卖 AUCTION_SOLD 未投影时 /evidence

- **前置条件**: 1s 拍卖,刚 hammer 完
- **测试步骤**:
  1. seller start 1s auction
  2. buyer bid
  3. 等 1s+ → Timer hammer
  4. **立即**(persistence 2s sweep 之前)curl /evidence
- **预期结果**: chainVerified=true(已有事件已链化),order 缺席,eventsHash 是 pre-SOLD chain head
- **意义**: 最终一致性窗口,需文档说明 "evidence is async; refresh after ~2s if expecting a SOLD"
- **优先级**: P3
- **是否已测**: TC-T4-005 用 8s deadline 隐式 mitigate,但没有专门验证 "before vs after" 区别

### TC-T4-110 — evidenceSummary 从链派生(非 Redis)✅ EXECUTABLE (PR #45)

> v2 新增。`8d8fa16` 把 evidence card 的 summary 字段从 live Redis snapshot 改为从持久化 hash 链 + order 派生(纯函数 `evidenceSummary(mysqlStatus, timeline, order, hasOrder)`)。现有测试只 e2e 覆盖 SOLD;NO_BID/CANCELLED/LIVE-with-bids 分支 + order override 只能经此纯函数验证 —— 直接 unit test,无 infra。

- **前置条件**: 无(纯函数);构造 `[]store.EvidenceEvent` timeline + `store.Order`
- **测试步骤 / 输入数据 / 预期结果**(5 表驱动 case):

| case | mysqlStatus | timeline | order | 预期 status | 预期 price | 预期 winner |
|---|---|---|---|---|---|---|
| LIVE + 2 bids | LIVE | bid(1,u1,11000), bid(2,u2,12000) | — | LIVE | 12000 | u2 |
| NO_BID | LIVE | AUCTION_NO_BID@1 | — | NO_BID | "" | "" |
| CANCELLED (有 bid) | LIVE | bid(1,u1,11000), CANCELLED@2 | — | CANCELLED | 11000 | u1 |
| SOLD (无 order) | LIVE | bid(1,u1,11000), SOLD@2 | — | SOLD | 11000 | u1 |
| SOLD + order | SOLD | bid+SOLD | order(u1,11000) | ORDER_CREATED | 11000 | u1 |

- **`seq`**: 每个 case `out.Seq` = timeline 最大 seq(派生自链,非 Redis snapshot.Seq)
- **本地结果**: ✅ PASS(5/5)
- **优先级**: P1(读路径正确性)

### TC-T4-111 — CANCELLED 拍卖 evidence card 仍带 winner/price(产品语义,新发现)

- **来源**: TC-T4-110 的 CANCELLED case 暴露
- **现象**: `evidenceSummary` 的 `case model.TypeAuctionCancelled:` 只设 `out.Status = CANCELLED`,**不清** 之前 BID_ACCEPTED 设的 `CurrentPriceCents`/`WinnerID`。所以一个有出价后被 cancel 的拍卖,evidence card 仍显示 `winnerId=最后出价人, currentPriceCents=最后出价`
- **冲突点**: T3 **TC-T3-013** 定义 "LIVE cancel 有 winner 仍走 CANCELLED,**买家不拿货**" —— 即 cancel 后无 winner。evidence card 展示一个"winner"可能误导查证者
- **预期(建议二选一)**:
  - (a) `evidenceSummary` 在 CANCELLED 分支清空 `WinnerID`/`CurrentPriceCents`(语义:无成交)
  - (b) proto/evidence-card.md 文档化 "CANCELLED 时 winnerId/currentPriceCents = 取消前最后一笔出价,非成交结果"
- **优先级**: P3(**非 correctness bug** — 链与状态都对,纯展示语义)
- **是否已测**: ✅ 行为被 TC-T4-110 钉死;**`b72a60e` 已采纳 (a)** — CANCELLED 分支清空 winner/price

### TC-T4-112 — projection-time seq SKIP 不能链成 verify(P0 假证据)✅ FIXED in PR #47

> 第二轮 review 发现(@Eliaaazzz [#35 CR](https://github.com/Eliaaazzz/live-auction-system/pull/35))。TC-T4-100 覆盖的是 **完整链建好后再删** 中间一行;本条覆盖 **投影时就缺一个 seq**。两者不同。

- **前置条件**: 空 auction_events;EVIDENCE_HMAC_KEY 已 load
- **测试步骤**:
  1. `InsertEvent(aid, seq=1, BID_ACCEPTED, p1)` → 链成 genesis
  2. `InsertEvent(aid, seq=3, BID_ACCEPTED, p3)`(**seq=2 缺失**)
  3. `VerifyEvidenceChain(aid)`
  4. 补 `InsertEvent(aid, seq=2, …)`,再 `InsertEvent(aid, seq=3, …)`(同 payload),再 verify
- **bug(fix 前)**: `fillEventHash` 用 `seq < ? ORDER BY seq DESC LIMIT 1` 取"最高的低于 N 的 seq",不是恰好 `seq-1` → seq=3 链到 seq=1(prev 有效) → **链成 1→3**。`VerifyEvidenceChain` 不查连续性 → 逐行重算 1→3 全 match → **返回 `(true, 0)`**。一个掉了事件的时间线被证据链"认证"为完整 —— tamper-evidence 系统里最坏的假绿
- **预期结果(fix 后)**:
  - 步骤 2 `InsertEvent(seq=3)` 返回 `ErrPreviousEventHashMissing`(closest prior seq=1 ≠ seq-1=2,不跨 gap 链)
  - 步骤 3 `VerifyEvidenceChain` 返回 `(false, 3)`(连续性断言在第一个非连续 seq break)
  - 步骤 4 补齐 seq=2 后,seq=3 重投影链到 seq=2,连续 → `(true, 0)`,count=3
- **fix(两层,PR #47)**:
  - `fillEventHash`:要求 closest prior == `seq-1`,否则 `ErrPreviousEventHashMissing`(transient — worker 按 seq 顺序投影,seq-1 下个 sweep 到)
  - `VerifyEvidenceChain`:加 expected-seq 连续性断言(defense-in-depth,覆盖 pre-fix/legacy 链)
- **是否已测**: ✅ `TestT4SeqSkipDoesNotChainOrVerify`(PR #47);现有 hash-chain 测试(genesis/idempotent/tamper/deletion)全部回归通过
- **优先级**: **P0**(证据完整性)

---

## 3. 执行计划

- **覆盖型 (TC-T4-001..011)**:
  - **v2 `8d8fa16`: 10 个落地** — 001/002/003 (hash 链) + 004 (order idempotent + mismatch) + 005 (e2e) + 011 (projectSold + missing-auction poison) + `TestT4HashChainDeletionBreaksAtSeq` + `TestT4HashFillWaitsForPreviousHash` + `TestT4EvidenceRequiresAuth`
  - 仍建议补:006 (type/payload mismatch 独立测) / 007 / 008 (CLI exit code) / 010 (schema 显式断言)
- **缺口型 (TC-T4-100..112)**:
  - **✅ RESOLVED in `8d8fa16`**(我 v1 提的 5 个 P0/P1 全闭环):100 (delete-detection), 101 (multi-worker fill via FOR UPDATE), 102 (crash self-heal), 104 (empty-winnerId poison → cursor advance), 107 (auth gate)。103 实质 fixed
  - **✅ EXECUTABLE in PR #45**:110 (evidenceSummary 派生);111 (CANCELLED-winner 语义)→ `b72a60e` 已修(清空 winner/price)
  - **🔴 P0 fixed in PR #47**:112 (projection-time seq skip → 假 verify)— 第二轮 review 发现,两层修复 + `TestT4SeqSkipDoesNotChainOrVerify`
  - **Tracked in issue #37**:105 (key rotation), 106 (VerifyEvidenceChain caching/perf), 108 (MySQL upgrade)
  - **文档化议题**:109 (最终一致性窗口)

## 4. 评审历史

- v1 (2026-05-25, @fariZzzz) — 初稿,基于 commit `8b27ccc`;提 10 覆盖型 + 10 缺口型,其中 P0/P1 缺口:100 (delete) / 101 (multi-worker fill) / 102 (crash) / 104 (empty-winnerId loop) / 107 (privacy)
- v2 (2026-05-25, @fariZzzz) — 对齐 `8d8fa16` (@PDGGK "harden T4 evidence projection"):我 v1 的 5 个 P0/P1 缺口全部被 patch(review→fix 闭环);新增覆盖型 011 + 多个落地测试映射;新增缺口型 110 (evidenceSummary 派生,executable in PR #45) + 111 (CANCELLED-winner 语义,probe 发现)。我 pull #34 @ `8d8fa16` 实测:`go test -race ./...` 全绿(真实 Redis+MySQL)。结论:hardening solid,re-affirm APPROVE
- v3 (2026-05-26, @fariZzzz) — 第二轮 review(@Eliaaazzz #35 CR)发现 **TC-T4-112 P0**:`fillEventHash` 链到"最高低于 N 的 seq"而非 `seq-1` + `VerifyEvidenceChain` 不查连续性 → `InsertEvent(1)+(3)` 链成 1→3 且 verify(假证据)。我实现两层修复 + `TestT4SeqSkipDoesNotChainOrVerify` 落在 **PR #47**(stacked on #34),server+store `-race` 全绿、现有 hash-chain 测试无回归。同时 111 (CANCELLED-winner) 经 `b72a60e` 采纳建议 (a) 关闭
