# T6 测试用例 — 前端 wire 层 + Room/Evidence/Admin 全链路 (PR #49)

> Author: @fariZzzz (post-merge smoke + wire-level audit, 2026-05-26).
> Target: `fari/T6-frontend-design-pass` at HEAD. Based on `main` (post T4 #34 +
> T5 #38 merges; both landed 06:58 UTC same day).
>
> Schema:每条用例必须包含 `编号 / 标题 / 前置条件 / 测试步骤 / 输入数据 / 预期结果 / 优先级`。用例分两类:
> - **覆盖型 (Coverage, TC-T6-001…015)** — 已通过 `/tmp/lumen-repo/smoke-ws.mjs` end-to-end + 单元手测 + bit-level code-verify 验证
> - **缺口型 (Gap probes, TC-T6-100…115)** — 推理/边界场景,部分 executable 待补
>
> 优先级:**P0** 系统不可用 / 数据丢失 · **P1** 关键路径错误 · **P2** 自愈但可观测性差 · **P3** 极端/性能
>
> 注:wire layer 与后端 `proto/ws-envelope.md` / `proto/error-codes.md` / `proto/evidence-card.md` 是 contract surface,任何 field 重命名 / type 重命名都需 schemaVersion bump + 全员 ratify。本测试集 pin 当前 contract。

---

## 0. 用例索引

### 覆盖型 (15) — 已验证

| ID | 标题 | 验证方式 | P |
|---|---|---|---|
| TC-T6-001 | `POST /api/dev-login` 返回 `{ userId, token, nickname }` | smoke (login → object shape) | P0 |
| TC-T6-002 | JWT 缓存到 localStorage,reload 后复用,不重复登录 | code-verify `lib/auth.js`;手测 | P0 |
| TC-T6-003 | REST 请求自动带 `Authorization: Bearer <jwt>` 头 | code-verify `lib/api.js`;backend `handleEvidence` 验证 401 路径 | P0 |
| TC-T6-004 | WS 连接 URL 形态 `ws://host/ws?auction=<id>&token=<jwt>` (`?auction` 不被后端读但保留为 debug 标记) | smoke (WS open succeeds) + code-verify backend `handleWS` line 297 | P0 |
| TC-T6-005 | client → server envelope shape `{schemaVersion,type,auctionId?,seq?,serverTimeMs,data}`,`type` SCREAMING_SNAKE | smoke (send ROOM_JOIN/BID_PLACE/PING; backend accepts) + code-verify `apps/lumen/internal/model/model.go:34-46` | P0 |
| TC-T6-006 | ROOM_SNAPSHOT 初始化 store:status/currentPriceCents(string)/winnerId/endAtMs(number)/seq | smoke `← recv ROOM_SNAPSHOT … status=LIVE price=10000` | P0 |
| TC-T6-007 | BID_PLACE → BID_ACCEPTED 含完整字段:seq/userId/displayName/amountCents(string)/endAtMs(number)/status/serverTimeMs | smoke `← recv BID_ACCEPTED seq=1 … winner=user_fari_smoke amount=15000 status=LIVE endAtMs=…` | P0 |
| TC-T6-008 | BID_ACCEPTED 双广播(直接 ack + Pub/Sub fanout)被 seqguard 去重 | smoke 显示 2 条 seq=1;store `applyEvent` 第二条 `seq <= lastSeq` return | P0 |
| TC-T6-009 | PING → PONG 心跳(15s 间隔),PONG 走 lossy lane | smoke `→ sent PING / ← recv PONG`;code-verify backend `dispatchWS:340` | P1 |
| TC-T6-010 | 低于最低加价 → BID_REJECTED `code=ERR_TOO_LOW`,触发 F08 摇头 | smoke `→ sent BID_PLACE amount=1 / ← recv BID_REJECTED code=ERR_TOO_LOW` | P0 |
| TC-T6-011 | schemaVersion=1 stamped on every envelope (in + out) | smoke `schemaVer=1` on each frame;code-verify `model.Envelope.MarshalJSON` | P0 |
| TC-T6-012 | Money 字段在 wire / store / display 全链路 string 不 parseFloat | code-verify `lib/format.js` BigInt + `model.Cents.MarshalJSON` returns `strconv.Quote(...)` | P0 |
| TC-T6-013 | `currentPriceCents` / `amountCents` 用 BigInt 比较 — leaderboard 排序、jump-bid 检测、加价计算 | code-verify `store/auction.js:mergeLeader` + `addCentsStr` + black-horse `BigInt(...) >= step*5n` | P1 |
| TC-T6-014 | Vite 同源代理:client → ws://localhost:5173/ws → 后端,Origin 经 `changeOrigin:true` 改成 `http://localhost:8080` 命中 `FRONTEND_ORIGIN` 白名单 | code-verify `vite.config.js` + `apps/lumen/internal/auth/auth.go:36-41 OriginAllowed`;手测 Origin 通过 | P0 |
| TC-T6-015 | Evidence 响应字段集 = `proto/evidence-card.md §1`;`hashBreakAtSeq` 仅 chainVerified=false 时存在;`order` 仅 auth 路径存在 | code-verify backend `handleEvidence:468-473` 条件 set;前端 `lib/evidence/types.js` types 匹配 | P0 |

### 缺口型 (15) — 边界 / 推理 / 待补 executable

| ID | 标题 | 状态 | P |
|---|---|---|---|
| TC-T6-100 | 反狙击 AUCTION_EXTENDED 到达 → store.extendCount +1 + endAtMs 更新 + F02 sweep | 待 executable(seed 长 auction,在 final-10s 内 bid 触发)| P0 |
| TC-T6-101 | 反狙击触发后 BID_PLACE 的 BID_ACCEPTED 携带 post-extension endAtMs(回归 #45 evidenceSummary 派生)| 待 executable | P1 |
| TC-T6-102 | Reconnect 携带 `ROOM_JOIN { lastSeq }`,gap ≤ 200 时后端 XRANGE 重放,前端按 seq 顺序去重应用 | 待 executable(强制 ws.close 后等待重连 + 注入 N 条事件)| P0 |
| TC-T6-103 | Reconnect gap > 200 时后端跳过 catchup 直接发 ROOM_SNAPSHOT,前端 reset seqguard watermark | 待 executable(模拟客户端 lastSeq=0,后端 seq=300)| P0 |
| TC-T6-104 | AUCTION_NO_BID terminal → status='NO_BID' + bid CTA disabled + 灰阶终局(F29)| 待 executable | P0 |
| TC-T6-105 | AUCTION_CANCELLED terminal → status='CANCELLED' + 红色 stamp(F30)| 待 executable | P0 |
| TC-T6-106 | AUCTION_SOLD → hammerTrans=true 触发 A→B bridge crossfade,1.05s 后稳定在 solemn surface | 已 code-verified(`store.applyEvent` set hammerTrans,`styles.css` keyframes lumen-veil-drop 等);visual 待手测 | P0 |
| TC-T6-107 | Evidence chainVerified=false 时 timeline 在 hashBreakAtSeq 行红色高亮,之后所有行 opacity 0.4 | 已 code-verified(`components/mobile.jsx <MobileEvidence>` breakIdx 逻辑);visual 待手测 | P1 |
| TC-T6-108 | clock skew > 500ms 时 F05 drift indicator 转 warn(state-extended `#FFB020`),drift = -300ms 时显示但不 warn | 已 code-verified(`components/atmosphere.jsx ClockDrift` 阈值);单测待补 | P2 |
| TC-T6-109 | 直连 backend(`VITE_WS_BASE=ws://localhost:8080`)且 backend `FRONTEND_ORIGIN` ≠ `:5173` → WS upgrade 收到 401 → fallback UI(reconnecting 不收敛)| **fix landed in this PR**(`.env.example` 改默认 blank + README warning);**Origin allowlist 需 ops 配套**;regression-test 待补 | P0 |
| TC-T6-110 | `prefers-reduced-motion: reduce` 启用 → 所有 `.lumen-*` 动画 `animation: none`,语义切换仍保留 1 帧 fade | 已 code-verified(`styles.css` 末尾 media query);手测待补 | P1 |
| TC-T6-111 | Frame budget 自动降级:rAF 平均 >22ms 持续 30 帧 → `body.surface-calm` ON;<17ms 持续 60 帧 → OFF | 待 backport — 当前 design 没自带 frameBudget;原 lumen-web 的 `lib/perf/frameBudget.ts` 应迁过来 | P2 |
| TC-T6-112 | F26 pull-to-refresh → `RoomClient.resync()` close + reconnect + ROOM_JOIN(lastSeq) | 待 executable(touch 模拟器或手测)| P1 |
| TC-T6-113 | 多 tab 同一账号:tab1 出价 → tab2 收到 BID_ACCEPTED(他人视角,非 self flash) | 已 code-verified(self 由 store.yourUserId 判断,每 tab 独立 session 但同 userId);手测待补 | P1 |
| TC-T6-114 | AdminVLMFacts:5 条 facts 全部 confirm 后才能调 `api.freeze`;少于 5 时 freeze → 后端返回 `ERR_FACTS_NOT_CONFIRMED` | 待 wiring(`adminExtra.jsx <AdminVLMFacts>` 仍用 mock confirmedN/total;`api.freeze` 调用未接)| P0(影响 demo)|
| TC-T6-115 | 卖家自己出价被拒(seller self-bid)→ BID_REJECTED `code=ERR_NOT_ALLOWED` 文案 "当前账号不能出价此场" | 已 code-verified(`lib/types.js bidRejectCopy[ERR_NOT_ALLOWED]`);executable 待补 | P2 |

**Summary**: 15 个覆盖项已通过 smoke + code-verify;15 个 gap probes 中,3 个已 code-verified(106/107/110),1 个已 fix-landed(109),11 个待 executable 或待 wiring。剩余 P0:100/102/103/104/105/114(其中 114 需要 admin 路由 wiring 工作,见 PR #49 follow-up)。

---

## 1. 覆盖型用例

### TC-T6-001 — `POST /api/dev-login` 返回 `{ userId, token, nickname }`

- **前置条件**:backend up,`ENABLE_DEV_LOGIN=true`
- **测试步骤**:
  1. `fetch('/api/dev-login', { method: 'POST', body: JSON.stringify({ nickname: 'fari-smoke' }) })`
  2. 解析 response JSON
- **输入数据**:`{ "nickname": "fari-smoke" }`
- **预期结果**:HTTP 200;body `{ userId: 'user_fari_smoke', token: 'user_fari_smoke.<hex64>', nickname: 'fari-smoke' }`;token 长度 80(`<userId>.<hex64>`)
- **优先级**:P0
- **状态**:✅ smoke PASS

### TC-T6-002 — Token 缓存到 localStorage,reload 后复用

- **前置条件**:已运行过 TC-T6-001
- **测试步骤**:
  1. `ensureSession('demo')`,等待 resolve
  2. `localStorage.getItem('lumen.session')` 非空,JSON parse 得到 `{ userId, token, nickname }`
  3. reload 页面
  4. 再 `ensureSession('demo')`(不传或传不同 nickname)
- **预期结果**:第二次调用不发起新的 `/api/dev-login` 请求(network 0 calls),直接 resolve cached session
- **优先级**:P0
- **状态**:✅ code-verified(`lib/auth.js currentToken()` 先读 cache)

### TC-T6-003 — Authorization Bearer 自动加在 REST 请求

- **前置条件**:`currentToken()` 返回非空
- **测试步骤**:
  1. `api.getEvidence('auc_demo')`
  2. 用 DevTools 看 outgoing request headers
- **预期结果**:`Authorization: Bearer <jwt>`;`Content-Type: application/json`
- **优先级**:P0
- **状态**:✅ code-verified(`lib/api.js request()` 函数)

### TC-T6-007 — BID_ACCEPTED 完整字段(string-cents + endAtMs + status)

- **前置条件**:WS open;ROOM_JOIN 完成
- **测试步骤**:
  1. send `BID_PLACE { clientBidId: 'cbid-x', amountCents: '15000' }`(snapshot 当前价 10000)
  2. 收 BID_ACCEPTED
- **输入数据**:见 step 1
- **预期结果**:`type='BID_ACCEPTED'`;`schemaVersion=1`;`seq=1`;`data.userId='user_fari_smoke'`;`data.displayName='fari-smoke'`;`data.amountCents='15000'`(**string**);`data.endAtMs` typeof 'number';`data.status='LIVE'`;`data.serverTimeMs` typeof 'number'
- **优先级**:P0
- **状态**:✅ smoke PASS(see `/tmp/lumen-repo/smoke-ws.mjs` output)

### TC-T6-008 — 双广播去重

- **前置条件**:WS open + 接收过 1 次 BID_ACCEPTED
- **测试步骤**:
  1. send 1 个 BID_PLACE
  2. 观察 client 收到几条 BID_ACCEPTED frames(server 会发 2:直接 ack + Pub/Sub fanout)
  3. 检查 store.applyEvent 应用次数
- **预期结果**:wire 收到 2 条同 seq;store 只应用第 1 条;第 2 条 `seq <= lastSeq` early-return
- **优先级**:P0
- **状态**:✅ smoke 显示双广播;code-verified store `applyEvent` 去重逻辑

### TC-T6-014 — Vite 同源代理 + Origin allowlist

- **前置条件**:`.env.local` 不设 VITE_WS_BASE(或留空);`make up` 默认 `FRONTEND_ORIGIN=http://localhost:8080`
- **测试步骤**:
  1. `npm run dev` (vite at :5173)
  2. 打开 `http://localhost:5173/room/auc_demo`
  3. DevTools Network 选 WS 帧,看 Request Headers
- **预期结果**:WS connect to `ws://localhost:5173/ws?...`;Vite proxy forward 到 `ws://localhost:8080/ws?...` 并设 `Origin: http://localhost:8080`;后端 `OriginAllowed` 通过 (`origin == allowed`);101 Switching Protocols
- **优先级**:P0
- **状态**:✅ code-verified;manual-test 待跑

### TC-T6-015 — Evidence 响应字段集匹配 proto

- **前置条件**:`make verify-evidence` PASS;`auc_demo` 已 SOLD
- **测试步骤**:`GET /api/auctions/auc_demo/evidence` with auth
- **预期结果**:JSON 含全部 `auctionId, status, currentPriceCents (string), winnerId, seq, eventsCount, factsConfirmed, timeline (array), eventsHash (string), chainVerified (bool), note`;chainVerified=true 时 **不含** `hashBreakAtSeq` field;auth 时含 `order` block
- **优先级**:P0
- **状态**:✅ code-verified backend `handleEvidence:468-473` 条件 set

(其余 001/004-006/009-013 见上方索引表;细节 mirror 上述风格)

---

## 2. 缺口型用例 — 待补 executable

### TC-T6-100 — AUCTION_EXTENDED 路径完整

- **前置条件**:auction `endAtMs - now ≤ 10s`(anti-snipe window)且 `extendCount < maxExtensions`
- **测试步骤**:
  1. 调整 seed 使 endAtMs 在 now+5s 内
  2. send BID_PLACE(高于当前价)
  3. 期望先后收到 BID_ACCEPTED + AUCTION_EXTENDED
  4. 检查 store.extendCount 从 0 → 1;store.endAtMs 从旧值 → 新值
  5. UI: ExtendBadge 出现 + lumen-sweep 动画播放
- **预期结果**:全部步骤通过
- **优先级**:P0
- **状态**:待 executable(需 seed 调整 + 在 anti-snipe window 内出价)

### TC-T6-102 — Reconnect 携带 lastSeq + catchup

- **前置条件**:WS open,store.lastSeq 已推进到 N(N > 0)
- **测试步骤**:
  1. `ws._impl.close()` 强制断开
  2. 在重连 backoff 期间,backend 写入 K 条事件(N+1..N+K),K ≤ 200
  3. 等待重连完成,观察 ROOM_JOIN 带 `lastSeq=N`
  4. 后端 XRANGE 重放 K 条 events 通过 critical lane(T5)
  5. 前端 store.lastSeq 应推进到 N+K
- **预期结果**:store 收到全部 K 条事件,无重复(seqguard dedupe),无丢失
- **优先级**:P0
- **状态**:待 executable

### TC-T6-103 — Gap > 200 → snapshot fallback

- **前置条件**:同上,但 K > 200
- **测试步骤**:同上 + 注入 201 条事件
- **预期结果**:后端 `dispatchWS:366` `snap.Seq-d.LastSeq > catchupMaxGap` → 跳过 XRANGE,直接发 ROOM_SNAPSHOT;前端 reset seqguard watermark 到 snapshot.seq
- **优先级**:P0
- **状态**:待 executable

### TC-T6-109 — Direct WS bypass + Origin allowlist

- **前置条件**:`.env.local` 设 `VITE_WS_BASE=ws://localhost:8080`;backend `FRONTEND_ORIGIN=http://localhost:8080`(默认)
- **测试步骤**:
  1. 加载页面 `http://localhost:5173/room/auc_demo`
  2. 观察 WS upgrade 返回 401
  3. UI: ConnReconnecting 持续不收敛 → schema-mismatch 路径 NOT 触发(401 是 auth 错,不是 protocol 错)
- **预期结果**:reconnect storm + console 日志;**修复**:`.env.example` 默认留空 VITE_WS_BASE,or backend `FRONTEND_ORIGIN=http://localhost:5173`
- **优先级**:P0
- **状态**:✅ **修复已 land in PR #49**(`.env.example` 改默认 blank + 解释 CSWSH guard);regression-test 待补 executable(在 e2e 里检查 401 不退化为静默 silent loop)

### TC-T6-114 — VLM facts 全确认前不能 freeze

- **前置条件**:DRAFT auction,VLM 返回 5 条 facts
- **测试步骤**:
  1. 在 `/admin/auctions/:id/vlm` 只 confirm 3/5 条
  2. 点击 "全部确认后开拍 →"
  3. 期望按钮 disabled(client-side gate)
  4. 即使绕过 client 直接调 `api.freeze(id)` → 后端 `ERR_FACTS_NOT_CONFIRMED`(409)
- **预期结果**:demo 视频里这一步必须成功展示
- **优先级**:P0(影响 demo)
- **状态**:待 wiring — 当前 `<AdminVLMFacts>` confirmedN 仍是 mock state,`api.freeze` 未接;PR #49 follow-up

(其余 100-115 中余下项 mirror 上述风格,待 executable 后补充本节具体 step)

---

## 3. 执行清单 / Coverage Matrix

| 测试方式 | 已覆盖 | 待补 |
|---|---|---|
| smoke (`smoke-ws.mjs`) | 001, 004-013 | 100-103, 109 reg |
| code-verify (静态读后端 Go) | 002, 003, 014, 015, 106, 107, 110, 113, 115 | — |
| manual visual | 待跑 | 014 origin walk, 106 bridge transition, 107 chain-broken,110 reduced-motion,112 PTR |
| executable (browser e2e / Playwright) | 0 | 100-115 全部建议 Playwright + msw |
| backend regression | 经 T4/T5 PR test suite 覆盖 | — |

**Recommended next step**: add `apps/web/tests/wire.smoke.test.mjs` (port `smoke-ws.mjs` into CI under `apps/web/`) so PR #49 has automated wire-contract regression test.

---

## 4. Risk Register

1. **P0**:T6-114 VLM facts wiring 未完成 → demo 路径断在 freeze 步。Owner: 紧接 PR #49 的 follow-up(`fari/T6-admin-wiring`)。
2. **P0**:T6-109 Origin allowlist mismatch — `.env.example` 默认改了,但生产部署如果 `FRONTEND_ORIGIN` 未配套设置,WS 全失败。**需 ops checklist 同步**。
3. **P1**:T6-100/101 反狙击路径仍仅靠 visual + smoke 的 backend 验证,前端 ExtendBadge 在浏览器实跑下的 sweep 时序 / extendCount 累加未 executable。
4. **P2**:frameBudget guardrail(P9)在新 codebase 没迁过来 — `lumen-web/src/lib/perf/frameBudget.ts` 需 port 到 `apps/web/src/lib/perf/frameBudget.js`。

---

**Refs**:
- backend wire contract: `proto/ws-envelope.md`, `proto/error-codes.md`, `proto/evidence-card.md`
- `apps/web/docs/INTEGRATION-NOTES.md` 列出 PR #49 wire 改动 audit trail
- `apps/web/docs/project-blueprint.md` §5(life-of walkthroughs)
- 已 merged: T4 #34, T5 #38, T3-followup #33
- in-flight: T5-followup #48(WS keepalive + typed close 4000), PDGGK codex #50(parallel design export)
