# T4 测试用例 — Persistence Hash Chain + Idempotent Order + Evidence Card (PR #34)

> Author: @fariZzzz (per [Workflow v2 global-scope review #15](https://github.com/Eliaaazzz/live-auction-system/issues/15)).
> Target: `elia/T4-persistence-order-evidence` at commit `8b27ccc`; based on `elia/T2-T3-rollup-to-main` (#31).
> Authored **before** the substantive PR #34 review per the team's "test cases first" precedent from T3 (PR #30 → CI tests in PR #33).
>
> Schema (per @fariZzzz 5/25 directive):每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`. 用例分两类:
> - **覆盖型 (Coverage, TC-T4-001…010)** — 对应 PR #34 现有的 5 个 `_test.go` 用例 + 5 个推断出来的合约级用例,作者 review 时用作可执行清单
> - **缺口型 (Gap probes, TC-T4-100…109)** — PR #34 当前未覆盖、但根据架构推理出的边界场景,建议补测或解释为何安全
>
> 优先级:**P0** 系统不可用 / 假证据 / 状态分裂 · **P1** 关键路径功能错误 · **P2** 自愈但可观测性差 · **P3** 极端/罕见 / 性能
>
> 注:hash 算法 = `HMAC_SHA256(key, prev || "\n" || dec(seq) || "\n" || event_type || "\n" || payload_json_normalized)`;genesis `prev=""`;`payload_json_normalized` = MySQL 读回后的形式(MySQL JSON 列归一化 key 顺序/whitespace)。`EVIDENCE_HMAC_KEY` 默认 `"change-me-evidence-local-only"`,生产环境必须改。

---

## 0. 用例索引

### 覆盖型 (10)

| ID | 标题 | 对应 PR #34 测试 | P |
|---|---|---|---|
| TC-T4-001 | genesis prev_hash 空,链接正确,VerifyEvidenceChain 通过 | `TestT4HashChainGenesisLinkAndVerify` | P0 |
| TC-T4-002 | 重复 InsertEvent 同 (aid, seq, payload) → 无重复行,event_hash 不变 | `TestT4HashChainIdempotentReprojection` | P0 |
| TC-T4-003 | 后改 payload_json → VerifyEvidenceChain 失败,hash_break_at_seq = 改动位置 | `TestT4HashChainTamperBreaksAtSeq` | P0 |
| TC-T4-004 | AUCTION_SOLD 重复投影 → 仅一个 orders 行,字段正确 | `TestT4OrderIdempotentOnSold` | P0 |
| TC-T4-005 | E2E:Timer hammer → AUCTION_SOLD → evidence card 显示链已 verified + order 存在 | `TestT4EvidenceAfterHammer` | P0 |
| TC-T4-006 | 不同 payload 投到同 (aid, seq) → ErrEventPayloadMismatch | (隐含在 InsertEvent;未独立测) | P0 |
| TC-T4-007 | `lumen verify-evidence` 链 OK → exit 0 | (隐含在 RunVerifyEvidence;未独立测) | P1 |
| TC-T4-008 | `lumen verify-evidence` 链 BROKEN → exit ≠ 0,日志含 `hash_break_at_seq=N` | (未测) | P1 |
| TC-T4-009 | EVIDENCE_HMAC_KEY 在 `APP_ENV != dev` 用默认值 → config.Load 失败 | (`config_test.go`,需确认) | P0 |
| TC-T4-010 | /evidence 返回 timeline + chainVerified + eventsHash + order 字段顺序与 proto 一致 | (隐含在 TC-T4-005) | P1 |

### 缺口型 (10) — PR #34 当前未覆盖,本 review 主张补测或解释

| ID | 标题 | 风险 | P |
|---|---|---|---|
| TC-T4-100 | 删除中间一行 auction_events,VerifyEvidenceChain 在下一行就 break | 漏报 → 假证据 | P0 |
| TC-T4-101 | 双 persistence worker 并发 InsertEvent 同 (aid, seq+1) → 一个赢,另一个 fillEventHash 是否会算错 prev? | 链生成错乱,VerifyEvidenceChain 后续全 false | P1 |
| TC-T4-102 | 持久化在 InsertEvent 与 fillEventHash 之间崩溃(模拟) → 重启后链自愈 | 关键自愈不变量需测试 | P1 |
| TC-T4-103 | 多 worker 同时 fillEventHash 同一行 → 一个赢,另一个 UPDATE WHERE event_hash IS NULL 是 no-op | idempotency 验证 | P1 |
| TC-T4-104 | AUCTION_SOLD payload 中 winnerId 空字符串 → CreateOrderFromSold 返错;但 fillEventHash 已经把链 advance 了吗? | 链 vs orders 表分裂 | P1 |
| TC-T4-105 | EVIDENCE_HMAC_KEY 中途轮换(prod) → pre-rotation 行验证失败 | 已知设计限制,需 doc + 操作手册 | P2 |
| TC-T4-106 | /evidence 在 10K event 链上的延迟 (单次 VerifyEvidenceChain) | DoS 风险,T8 perf 议题 | P2 |
| TC-T4-107 | /evidence 暴露 buyerId 给未认证调用者(没有 auth gate) | 私有数据泄漏 | P1 |
| TC-T4-108 | MySQL JSON 归一化跨版本差异 → 旧链 hash 校验失败 | 升级风险,长期 | P3 |
| TC-T4-109 | TimerHammer 极短窗口 (<2s) AUCTION_SOLD 还没投影,/evidence 看不到 order | 最终一致性窗口,需明确 | P3 |

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

- **前置条件**: 3 条事件已链化(TC-T4-001 扩展)
- **测试步骤**:
  1. VerifyEvidenceChain 前置 ok
  2. `DELETE FROM auction_events WHERE auction_id=? AND seq=2`
  3. VerifyEvidenceChain
- **预期结果**: `(ok=false, break=3, nil)`(seq=3 的 prev_hash 指向 seq=2 的 event_hash,但 running head 是 seq=1 的 event_hash → mismatch)
- **意义**: 漏报会导致 partial evidence 通过 verify,假证据风险
- **是否已测**: ❌ — PR #34 只测了 payload 篡改,**没有测删除**

### TC-T4-101 — 双 persistence worker 并发 InsertEvent 链生成

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

---

## 3. 执行计划

- **覆盖型 (TC-T4-001..010)**:
  - 5 个已实现 (TC-T4-001/002/003/004/005)
  - 5 个建议补 (TC-T4-006 错误返回 / TC-T4-007 CLI exit 0 / TC-T4-008 CLI exit ≠ 0 / TC-T4-009 config / TC-T4-010 schema)
- **缺口型 (TC-T4-100..109)**:
  - **P0/P1 建议在本 PR 或 follow-up PR 落地**: 100 (delete-detection), 101 (multi-worker), 102 (crash-recovery), 103 (concurrent fill), 104 (empty winnerId loop), 107 (privacy)
  - **P2 perf / 升级议题**: 105 (key rotation), 106 (10K perf), 108 (MySQL version), 109 (eventual consistency window) — 文档化,T8/T-后跟进

## 4. 评审历史

- v1 (2026-05-25, @fariZzzz) — 初稿,基于 commit `8b27ccc`,base = elia/T2-T3-rollup-to-main(#31 in review)
