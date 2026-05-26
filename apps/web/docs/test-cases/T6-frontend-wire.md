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
| TC-T6-104 | AUCTION_NO_BID terminal → status='NO_BID' + bid CTA disabled + 灰阶终局(F29)| 🟡 UI shipped in PR #54 (`<TerminalOverlay>` in mobile.jsx — quiet calm gradient + "本场无人出价 · 流拍 · 序列号已上链" copy);executable e2e 待 Playwright | P0 |
| TC-T6-105 | AUCTION_CANCELLED terminal → status='CANCELLED' + 红色 stamp(F30)| 🟡 UI shipped in PR #54 (`<TerminalOverlay>` red-tinted variant + "本场已取消 · 卖家终止 · 序列号已上链" copy);executable e2e 待 Playwright | P0 |
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

**Summary** (post-PR #51 #53 #54 self-review pass, 2026-05-26):
- 覆盖项 15/15 通过 smoke + code-verify
- 100-115 gap probes 现状:
  - ✅ resolved in PR #51: 109 (Origin trap), 110 (reduced-motion auto-degrade), 111 (frame budget port), 112 (F26 pull-to-resync wired)
  - ✅ resolved in PR #53: 114 (VLM freeze gate wired)
  - 🟡 partially covered in PR #51 (Evidence route): 107 (CHAIN BROKEN UI live now)
  - 待 executable: 100 / 101 / 102 / 103 / 104 / 105 / 108 / 113 / 115 — all browser-e2e candidates

剩余 P0 缺口:100/102/103/104/105 — all need Playwright + a controlled backend fixture (timer + seed manipulation).

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

## 3. PR #51 / #53 / #54 follow-up — admin wiring · buyer polish · perf guardrail

Self-review pass 2026-05-26 covering everything that landed after PR #49.
Cases are grouped by feature; numbering continues from the 100-series so
existing tooling and dev-log links don't break.

### 3.1 索引

| ID | Subject | Owner PR | Type | P |
|---|---|---|---|---|
| TC-T6-200 | AdminPublish — valid form submit → createProduct + createDraft + navigate | #53 | wire | P0 |
| TC-T6-201 | AdminPublish — busy lock prevents double-submit | #53 | race | P1 |
| TC-T6-202 | AdminPublish — ApiError code surfaces in bottom strip | #53 | error | P1 |
| TC-T6-203 | AdminPublish — `reserve > start` blocks `valid`, button disabled | #53 | guard | P2 |
| TC-T6-204 | AdminPublish — `cap <= start` blocks `valid`, button disabled | #53 | guard | P2 |
| TC-T6-205 | AdminPublish — `antiSnipe=false` sets `maxExtensions=0` in rules | #53 | semantics | P1 |
| TC-T6-210 | AdminVLMFacts — confirm action: status→confirmed, editedText←vlmText | #53 | wire | P0 |
| TC-T6-211 | AdminVLMFacts — edit via prompt: status→edited, editedText←input | #53 | wire | P1 |
| TC-T6-212 | AdminVLMFacts — restore action: status→pending, editedText cleared | #53 | wire | P2 |
| TC-T6-213 | AdminVLMFacts — delete action: card removed from state, total dec | #53 | wire | P2 |
| TC-T6-214 | AdminVLMFacts — gateOpen recomputes correctly when total=0 (all deleted) | #53 | edge | P1 |
| TC-T6-215 | AdminVLMFacts — freeze + start chain: OK_FROZEN → OK_LIVE → navigate | #53 | wire | P0 |
| TC-T6-216 | AdminVLMFacts — backend ERR_FACTS_NOT_CONFIRMED surfaces in bottom copy | #53 | error | P0 |
| TC-T6-217 | AdminVLMFacts — start fails after freeze succeeds: stays on VLM page with error (no orphan SCHEDULED) | #53 | race | P1 |
| TC-T6-218 | AdminVLMFacts — busy state prevents double freeze | #53 | race | P1 |
| TC-T6-220 | AdminConsole — broadcaster subscribe: store fills, self never fires leadingToast | #53 | wire | P0 |
| TC-T6-221 | AdminConsole — bid stream rows order: newest first (reverse-chrono) | #53 | order | P1 |
| TC-T6-222 | AdminConsole — unique-bidder count = `Set(BID_ACCEPTED.userId).size` | #53 | derive | P2 |
| TC-T6-223 | AdminConsole — cancel button disabled / opacity 0.5 when no `:id` | #53 | guard | P2 |
| TC-T6-224 | AdminConsole — extends store with N events; LAST 3 REJECTS shows newest 3 | #53 | derive | P2 |
| TC-T6-225 | AdminConsole — navigating away calls `client.leave()`; no leaked WS | #53 | cleanup | P1 |
| TC-T6-230 | Podium — exactly 3 leaders: visual order [#2, #1, #3]; #1 raised | #54 | layout | P1 |
| TC-T6-231 | Podium — 2 leaders: only [#1, #2] render, no empty #3 slot | #54 | edge | P1 |
| TC-T6-232 | Podium — 1 leader: only #1 renders, centered, no podium structure broken | #54 | edge | P1 |
| TC-T6-233 | Podium — 0 leaders: container empty, no JS error | #54 | edge | P2 |
| TC-T6-234 | Podium — `isYou` flag renders YOU chip; not on others | #54 | display | P2 |
| TC-T6-235 | Podium — medal colors: gold #1 / silver #2 / bronze (bridge-rose-gold) #3 | #54 | tokens | P2 |
| TC-T6-240 | Chips — `+1%` snaps UP to `current + step` (not below the floor) | #54 | math | P0 |
| TC-T6-241 | Chips — `+5%` and `+10%` snap to next step multiple of `current` | #54 | math | P0 |
| TC-T6-242 | Chips — `MAX` with `capCents=null` → falls back to `+10%` | #54 | edge | P0 |
| TC-T6-243 | Chips — `MAX` with `capCents` set → returns exactly `capCents` | #54 | edge | P1 |
| TC-T6-244 | Chips — BigInt overflow guard: pct math doesn't lose precision at 9e15 cents | #54 | precision | P1 |
| TC-T6-245 | Chips — `disabled` (status ≠ LIVE) → no onBid fires on tap | #54 | guard | P0 |
| TC-T6-246 | Chips — `shake` prop fires `.lumen-shake` only on the chip group, not chrome | #54 | css | P2 |
| TC-T6-247 | Custom drawer — empty input → submit disabled | #54 | guard | P1 |
| TC-T6-248 | Custom drawer — input ≤ currentCents → submit disabled (no underbid) | #54 | guard | P0 |
| TC-T6-249 | Custom drawer — non-numeric chars stripped via onChange `replace(/[^0-9]/g)` | #54 | input | P2 |
| TC-T6-250 | HeatMeter — `bidsPerSec=0` → bar at 0% width, mono shows `0.0/s` | #54 | derive | P2 |
| TC-T6-251 | HeatMeter — `bidsPerSec > peak` clamps width to 100% (no overflow) | #54 | edge | P1 |
| TC-T6-252 | HeatMeter — color thresholds: <0.3 cyan / <0.7 orange / else red | #54 | tokens | P2 |
| TC-T6-253 | HeatMeter — 5s window: events older than 5s drop from rate; tested with mock recentEvents | #54 | window | P1 |
| TC-T6-254 | HeatMeter — clock skew applied: nowMs = Date.now() + serverClockOffsetMs (not raw Date.now) | #54 | P4 | P1 |
| TC-T6-260 | SOLD shake — one-shot: fires once on `status` LIVE→SOLD; re-renders don't retrigger | #54 | race | P0 |
| TC-T6-261 | SOLD shake — composes with `screenShake` prop: either flag enables `.lumen-screen-shake` | #54 | css | P2 |
| TC-T6-262 | SOLD shake — auto-clear in ~700ms (single timeout, no loop) | #54 | timing | P1 |
| TC-T6-263 | SOLD shake — does NOT fire on initial mount when status already SOLD (`lastStatusRef`-gated) | #54 | edge | P1 |

### 3.2 Cross-cutting · security · race conditions

| ID | Subject | Cases covered | P |
|---|---|---|---|
| TC-T6-270 | Bearer token absent → REST returns 401 with `code` in body; ApiError surfaces | wire/api.go authUser | P0 |
| TC-T6-271 | Bearer token expired (server-rotated `JWT_SECRET`) → 401 → frontend should clear session + re-login. Currently we DON'T retry. **Gap**: future ApiError 401 handler | wire | P1 |
| TC-T6-272 | Two tabs same userId, both place BID_PLACE concurrently with same `clientBidId` → backend dedupe Hash collapses; one BID_ACCEPTED replayed | wire | P1 |
| TC-T6-273 | Component unmount mid-fetch (route switch) → `alive` flag prevents `setState` after unmount; no React warnings | LiveRoomRoute / EvidenceRoute / AdminConsole all use this pattern | P0 |
| TC-T6-274 | localStorage disabled (private mode) → `lib/auth.js` writeStorage catches; in-memory cache still works for this session | auth | P2 |
| TC-T6-275 | DevTools "throttle CPU 6x" → frameBudget guardrail flips `body.surface-calm` → decorative animations stop | P9 | P1 |
| TC-T6-276 | Slow network: WS open succeeds but ROOM_JOIN hangs > 3s → user sees `connStatus='syncing'` until first event | P7 | P2 |
| TC-T6-277 | `crypto.randomUUID` unavailable (older browser) → handleBid falls back to `cbid-{ts}-{random36}` | LiveRoomRoute | P2 |
| TC-T6-278 | Custom drawer XSS — input is rendered only into `<input value>` and posted as JSON; never injected as HTML | security | P0 |
| TC-T6-279 | High-fact-confidence cards: still need seller action — UI never auto-confirms regardless of `confidence > 0.99` | P3 / AI non-authoritative | P1 |

### 3.3 Test execution detail (selected high-priority cases)

#### TC-T6-200 — AdminPublish valid submit → navigate

- **前置条件**:`/admin/auctions/new` 已加载;backend up
- **测试步骤**:
  1. 表单保留默认值(`title='百达翡丽 5711/1A · 蓝面'`,`startCents='12000000'`,`stepCents='500000'`,`reserveCents='10000000'`,`capCents='30000000'`)
  2. 点击 "下一步 · VLM 核对 →"
- **预期结果**:
  - DevTools Network:`POST /api/products` 返回 `{ productId: 'prod_…' }`
  - 紧接着 `POST /api/auctions` 返回 `{ auctionId: 'auc_…' }`
  - 路由跳转到 `/admin/auctions/<auctionId>/vlm`
  - 按钮按下后立即变 disabled + 文字变 "正在创建 …"(busy state)
- **优先级**:P0
- **状态**:✅ code-verified — `adminExtra.jsx handleSubmit`;executable 待 Playwright

#### TC-T6-216 — VLM freeze gate · backend ERR_FACTS_NOT_CONFIRMED 路径

- **前置条件**:DRAFT auction 存在但 backend `factsConfirmed` 仍为 false(VLM 流程未走完);用户绕过 client gate 手动触发 `api.freeze()`(例如 DevTools console)
- **测试步骤**:
  1. `await api.freeze('auc_<id>')` 在 DevTools 中直接调用
  2. 观察 fetch response
- **预期结果**:
  - HTTP 409 + body `{ code: 'ERR_FACTS_NOT_CONFIRMED', message: '...' }`
  - 前端 `ApiError` 抛出,UI 底部门禁文案变 "开拍失败 · ERR_FACTS_NOT_CONFIRMED · ..."
  - 用户回到 VLM 页继续 confirm
- **优先级**:P0
- **状态**:✅ code-verified — backend `api.go handleFreeze` 检查;前端 `admin.jsx handleFreezeAndStart` catch + 显示

#### TC-T6-217 — Freeze succeeded but Start failed (race / state-leak edge)

- **前置条件**:freeze 调用成功后,start_auction.lua 因为竞态(timer 抢先 / Redis 故障)返回 ERR_BAD_STATE
- **测试步骤**:
  1. 模拟 freeze 200 + start 409
  2. 观察 UI
- **预期结果**:
  - 用户停在 VLM 页(没有跳到 live console)
  - 底部门禁文案 "开拍失败 · ERR_BAD_STATE · …"
  - **不会**走出 SCHEDULED orphan 状态(后端的 start 失败保持 SCHEDULED;用户可以重试)
  - 客户端 UI 状态没有 corrupted 残留
- **优先级**:P1
- **状态**:✅ code-verified — `handleFreezeAndStart` 顺序 try/catch;每步独立 throw

#### TC-T6-240 — Chip percent snap-up math

- **前置条件**:`currentCents='12880000'`,`stepCents='500000'`
- **测试步骤**:
  - +1% chip:
    - `raw = 12880000 * 101 / 100 = 13008800`
    - `minTarget = 12880000 + 500000 = 13380000`
    - `raw < minTarget` → `snapped = minTarget = 13380000`
    - `above = 500000`,`stepsUp = 1`,result = `12880000 + 500000 = 13380000` ✅
  - +5% chip:
    - `raw = 12880000 * 105 / 100 = 13524000`
    - `snapped = 13524000`(`> minTarget`)
    - `above = 644000`,`stepsUp = ceil(644000 / 500000) = 2`,result = `12880000 + 1000000 = 13880000` ✅
  - +10% chip:
    - `raw = 12880000 * 110 / 100 = 14168000`
    - `above = 1288000`,`stepsUp = 3`,result = `12880000 + 1500000 = 14380000` ✅
- **预期结果**:所有 chip 显示的 cents 都满足 `bid >= current + step` (place_bid.lua 接受) 且对齐到 step 倍数
- **优先级**:P0
- **状态**:✅ code-verified — `primitives.jsx QuickBidChips pctBump`

#### TC-T6-242 — MAX 兜底逻辑

- **前置条件**:auction 未设 cap(`capCents=null`)
- **测试步骤**:观察 MAX chip 显示的 cents
- **预期结果**:MAX = `pctBump(10)` 的结果,与 +10% chip 完全相同
- **优先级**:P0
- **状态**:✅ code-verified — `primitives.jsx QuickBidChips maxBid()`

#### TC-T6-244 — BigInt precision at max-money boundary

- **前置条件**:`currentCents='9000000000000000'`(≈ 9e15,接近 `MaxMoneyCents = 2^53-1`),`stepCents='1000000'`
- **测试步骤**:点 +1% chip
- **预期结果**:
  - `raw = BigInt(9e15) * 101n / 100n = 9090000000000000n`(精确,无 float 截断)
  - `snapped`,`stepsUp` 全程 BigInt;结果是 `string`,不是 `Number`
  - 实际值不超过 `MaxMoneyCents`;若超过,backend `ERR_BAD_INPUT` 兜底
- **优先级**:P1
- **状态**:✅ code-verified — `pctBump` 全 BigInt

#### TC-T6-251 — HeatMeter overflow

- **前置条件**:`bidsPerSec=12`,`peak=6`
- **测试步骤**:render `<HeatMeter bidsPerSec={12} peak={6}/>`
- **预期结果**:
  - `ratio = Math.min(1, 12/6) = 1`(不溢出)
  - 进度条 width: `100%`
  - 颜色:`var(--state-live)`(`#FE2C55`)
  - 文字 "12.0/s"
- **优先级**:P1
- **状态**:✅ code-verified — `primitives.jsx HeatMeter ratio = Math.min(1, ...)`

#### TC-T6-260 — SOLD shake one-shot

- **前置条件**:`<MobileRoom status="LIVE">` mounted
- **测试步骤**:
  1. observe no shake class
  2. prop change to `status='SOLD'` (1st time)
  3. wait 700ms
  4. trigger an unrelated re-render (e.g. `currentCents` prop change) while `status='SOLD'`
- **预期结果**:
  - step 1: `.lumen-screen-shake` 不在 class list
  - step 2: 立即添加 `.lumen-screen-shake`
  - step 3: 自动移除(700ms timeout fires)
  - step 4: **不**重新添加(`lastStatusRef.current === 'SOLD'`,无 LIVE→SOLD transition)
- **优先级**:P0(防止 hammer 视觉 loop)
- **状态**:✅ code-verified — `mobile.jsx hammerShake useEffect with lastStatusRef`

#### TC-T6-263 — SOLD shake skip on initial mount-already-sold

- **前置条件**:用户直接打开 `/room/auc_demo` 且 auction 已经 SOLD
- **测试步骤**:首次 mount 时 `status='SOLD'` 即生效
- **预期结果**:
  - `lastStatusRef.current` 初始值 = `status` = `'SOLD'`
  - useEffect 触发但 `lastStatusRef.current !== 'SOLD'` 检查 false → 不 shake
  - 用户看到 HammerOverlay 但没有屏幕震动(预期 — 这是历史记录,不是刚发生的事)
- **优先级**:P1
- **状态**:✅ code-verified — `lastStatusRef` 初始化为 `status` 不是 `null`

---

## 4. 执行清单 / Coverage Matrix

| 测试方式 | 已覆盖 | 待补 |
|---|---|---|
| smoke (`smoke-ws.mjs`) | 001, 004-013 | 100-103, 109 reg |
| code-verify (静态读后端 Go + 本地组件) | 002, 003, 014, 015, 106, 107, 110, 111, 112, 113, 114, 115, 200, 202-218, 220-225, 230, 234, 235, 240-244, 247-249, 250-254, 260-263, 270, 272, 273, 277, 278 | — |
| manual visual | 待跑 | 014 origin walk · 106 bridge transition · 107 chain-broken · 110 reduced-motion · 112 PTR · 230-235 podium variants · 250-252 heat colors · 260 shake |
| executable (browser e2e / Playwright) | 0 | 100-105 真 backend 时序 · 200-225 admin 全链 · 230-263 视觉断言 · 270-279 cross-cutting |
| backend regression | T4 #34 / T5 #38 / T3 #33 PR test suite | — |

**Recommended next steps**:
1. Wire `scripts/smoke-wire.mjs` into CI (GitHub Actions matrix: `make up` → seed → `npm run smoke:wire`). Catches every wire-contract regression in seconds.
2. Add Playwright project covering 200-225 (admin flow) + 240-249 (chips) + 260-263 (shake). Estimated 1 PR, ~400 LOC.
3. Add Vitest unit suite for the pure-math helpers in QuickBidChips (`pctBump` + `maxBid`) — instant CI feedback, no infra.

---

## 5. Risk Register (post #51 #53 #54 + review-resolution patches 2026-05-26)

**Resolved:**
1. ✅ **P0 → resolved**:T6-114 (VLM freeze gate) wired in PR #53.
2. ✅ **P0 → resolved**:T6-109 (Origin trap) fixed in PR #51's `.env.example` + README. Ops still need to set `FRONTEND_ORIGIN` correctly in deploys — flagged as runbook item, not a code issue.
3. ✅ **P1 → resolved**:T6-217 (freeze-then-start race orphan) — fix landed in PR #53 commit `065a49d` after @Eliaaazzz review. `handleFreezeAndStart` now treats `ERR_BAD_STATE` on freeze as "already frozen, proceed to startLive". Vitest assertion still recommended but not blocking.
4. ✅ **P1 → resolved**:T6-271 (expired JWT not re-handled) — fix landed in PR #51 commit `646c52b`. 401 from REST now calls `handleAuthFailure()` → clears cached session + dispatches `lumen:session-expired` custom event for route-level UX recovery.
5. ✅ **P1 → resolved**:T6-#54-H1 (stepCents=0 silent panic) — store default `'500000'` + `stepUsable` guard in `<QuickBidChips>` (PR #54 commit `8e08cdf`).
6. ✅ **P1 → resolved**:T6-#54-H2 (NO_BID / CANCELLED terminal UX missing) — `<TerminalOverlay>` component (PR #54).
7. ✅ **P1 → resolved**:T6-#54-H3 (custom drawer MaxMoneyCents overflow) — three-layer guard: maxLength=17 + BigInt validation + inline error copy (PR #54).
8. ✅ **P1 → resolved**:T6-#51-H4 (HMAC custody indirect doc reference) — inline threat-model summary added to `EvidenceRoute.jsx` (PR #51 commit `646c52b`).

**Still open:**
9. **P1**:T6-100/101 (anti-snipe path executable e2e) — needs Playwright + a backend fixture that can be told to end in 5s. Still the highest-priority remaining gap.
10. **P2**:T6-272 (concurrent same clientBidId across tabs) — backend dedupe handles it; UX could be clearer.
11. **P2**:Backend `RoomSnapshotData` doesn't ship `stepCents` / `capCents` / `extendCount` yet — frontend defaults to `'500000'` / `null` / preserves running count. Real values come from `api.getAuction` once backend extends the DTO. Track as T7 polish.
12. **P3**:T6-273 (alive-flag pattern in all routes) — code-verified, no executable test pinning it.

---

**Refs**:
- backend wire contract: `proto/ws-envelope.md`, `proto/error-codes.md`, `proto/evidence-card.md`
- `apps/web/docs/INTEGRATION-NOTES.md` 列出 PR #49 wire 改动 audit trail
- `apps/web/docs/project-blueprint.md` §5(life-of walkthroughs)+ §13 cross-check rubric
- 已 merged: T4 #34, T5 #38, T3-followup #33
- PR stack (review-pending): #49 · #50 · #51 · #53 · #54 · plus Elia's #52 (round-2 prototype) and Elia's #48 (T5 keepalive followup)
- in-flight: T5-followup #48(WS keepalive + typed close 4000), PDGGK codex #50(parallel design export)
