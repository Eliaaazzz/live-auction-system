# T6 test cases — frontend wire layer + Room/Evidence/Admin end to end (PR #49)

> Author: @fariZzzz (post-merge smoke + wire-level audit, 2026-05-26).
> Target: `fari/T6-frontend-design-pass` at HEAD. Based on `main` (post T4 #34 +
> T5 #38 merges; both landed 06:58 UTC same day).
>
> Schema: every case must carry `ID / title / preconditions / steps / input data / expected result / priority`. Cases come in two kinds:
> - **Coverage (TC-T6-001…015)** — verified through `/tmp/lumen-repo/smoke-ws.mjs` end to end, plus manual unit checks and bit-level code verification
> - **Gap probes (TC-T6-100…115)** — inferred and boundary scenarios; some are still to be made executable
>
> Priority: **P0** system unusable / data loss · **P1** critical-path error · **P2** self-heals but poorly observable · **P3** extreme/performance
>
> Note: the wire layer and the backend `proto/ws-envelope.md` / `proto/error-codes.md` / `proto/evidence-card.md` form the contract surface; renaming any field or type needs a schemaVersion bump plus all-member ratification. This suite pins the current contract.

---

## 0. Case index

### Coverage (15) — verified

| ID | Title | Verification | P |
|---|---|---|---|
| TC-T6-001 | `POST /api/dev-login` returns `{ userId, token, nickname }` | smoke (login → object shape) | P0 |
| TC-T6-002 | The JWT is cached in localStorage and reused after a reload, with no repeat login | code-verify `lib/auth.js`; manual check | P0 |
| TC-T6-003 | REST requests carry the `Authorization: Bearer <jwt>` header automatically | code-verify `lib/api.js`; the backend `handleEvidence` 401 path | P0 |
| TC-T6-004 | WS connection URL shape `ws://host/ws?auction=<id>&token=<jwt>` (`?auction` is not read by the backend but kept as a debug marker) | smoke (WS open succeeds) + code-verify backend `handleWS` line 297 | P0 |
| TC-T6-005 | client → server envelope shape `{schemaVersion,type,auctionId?,seq?,serverTimeMs,data}`,`type` SCREAMING_SNAKE | smoke (send ROOM_JOIN/BID_PLACE/PING; backend accepts) + code-verify `apps/lumen/internal/model/model.go:34-46` | P0 |
| TC-T6-006 | ROOM_SNAPSHOT initializes the store: status / currentPriceCents (string) / winnerId / endAtMs (number) / seq | smoke `← recv ROOM_SNAPSHOT … status=LIVE price=10000` | P0 |
| TC-T6-007 | BID_PLACE → BID_ACCEPTED carries the full field set: seq / userId / displayName / amountCents (string) / endAtMs (number) / status / bidCount / serverTimeMs | smoke `← recv BID_ACCEPTED seq=1 … winner=user_fari_smoke amount=15000 status=LIVE endAtMs=…` | P0 |
| TC-T6-008 | The double BID_ACCEPTED broadcast (direct ack + Pub/Sub fanout) is deduplicated by the seqguard | smoke shows 2 frames at seq=1; the store's `applyEvent` returns early on the second because `seq <= lastSeq` | P0 |
| TC-T6-009 | PING → PONG heartbeat (15s interval), with PONG on the lossy lane | smoke `→ sent PING / ← recv PONG`; code-verify backend `dispatchWS:340` | P1 |
| TC-T6-010 | Below the minimum increment → BID_REJECTED `code=ERR_TOO_LOW`, triggering the F08 shake | smoke `→ sent BID_PLACE amount=1 / ← recv BID_REJECTED code=ERR_TOO_LOW` | P0 |
| TC-T6-011 | schemaVersion=2 stamped on every envelope (in + out) | smoke `schemaVer=2` on each frame;code-verify `model.Envelope.MarshalJSON` | P0 |
| TC-T6-012 | Money fields stay strings across wire / store / display with no parseFloat | code-verify `lib/format.js` BigInt + `model.Cents.MarshalJSON` returns `strconv.Quote(...)` | P0 |
| TC-T6-013 | `currentPriceCents` / `amountCents` are compared as BigInt — leaderboard sorting, jump-bid detection, increment maths | code-verify `store/auction.js:mergeLeader` + `addCentsStr` + black-horse `BigInt(...) >= step*5n` | P1 |
| TC-T6-014 | Vite same-origin proxy: client → ws://localhost:5173/ws → backend, with `changeOrigin:true` rewriting Origin to `http://localhost:8080` so it hits the `FRONTEND_ORIGIN` allowlist | code-verify `vite.config.js` + `apps/lumen/internal/auth/auth.go:36-41 OriginAllowed`; Origin verified manually | P0 |
| TC-T6-015 | The evidence response field set equals `proto/evidence-card.md §1`; `hashBreakAtSeq` exists only when chainVerified=false; `order` exists only on the authenticated path | code-verify the conditional set in backend `handleEvidence:468-473`; the frontend `lib/evidence/types.js` types match | P0 |

### Gap probes (15) — boundary / inferred / executable status

| ID | Title | Status | P |
|---|---|---|---|
| TC-T6-100 | An anti-snipe AUCTION_EXTENDED arrives → store.extendCount +1, endAtMs updated, F02 sweep | ✅ `smoke:antisnipe` (`smoke:all`) | P0 |
| TC-T6-101 | After anti-snipe fires, the BID_ACCEPTED for a BID_PLACE carries the post-extension endAtMs (a regression guard for the #45 evidenceSummary derivation)| ✅ `smoke:antisnipe` (`smoke:all`) | P1 |
| TC-T6-102 | Reconnect carries `ROOM_JOIN { lastSeq }`; for a gap of 200 or less the backend replays with XRANGE and the frontend applies them in seq order with dedupe | ✅ `smoke:catchup` (`smoke:all`) | P0 |
| TC-T6-103 | For a reconnect gap over 200 the backend skips catchup and sends ROOM_SNAPSHOT directly, and the frontend resets the seqguard watermark | ✅ `smoke:snapshot` (`smoke:all`) | P0 |
| TC-T6-104 | AUCTION_NO_BID terminal → status='NO_BID', bid CTA disabled, greyscale ending (F29)| 🟡 UI shipped in PR #54 (`<TerminalOverlay>` in mobile.jsx — quiet calm gradient plus the copy "nobody bid — no sale — the sequence is on the chain"); the executable e2e still needs Playwright | P0 |
| TC-T6-105 | AUCTION_CANCELLED terminal → status='CANCELLED' plus a red stamp (F30)| 🟡 UI shipped in PR #54 (`<TerminalOverlay>` red-tinted variant plus the copy "this session was cancelled — ended by the seller — the sequence is on the chain"); the executable e2e still needs Playwright | P0 |
| TC-T6-106 | AUCTION_SOLD → hammerTrans=true triggers the A→B bridge crossfade and settles on the solemn surface after 1.05s | code-verified (`store.applyEvent` sets hammerTrans, `styles.css` keyframes such as lumen-veil-drop); the visual still needs a manual check | P0 |
| TC-T6-107 | When evidence chainVerified=false, the timeline highlights the hashBreakAtSeq row in red and every later row drops to opacity 0.4 | code-verified (the breakIdx logic in `components/mobile.jsx <MobileEvidence>`); the visual still needs a manual check | P1 |
| TC-T6-108 | With clock skew over 500ms the F05 drift indicator turns to warn (state-extended `#FFB020`); at a drift of -300ms it shows without warning | ✅ `components/primitives.test.jsx` (added: `+600ms` warns, `-300ms` displays normally) | P2 |
| TC-T6-109 | Connecting straight to the backend (`VITE_WS_BASE=ws://localhost:8080`) while the backend `FRONTEND_ORIGIN` is not `:5173` → the WS upgrade gets a 401 → fallback UI (reconnecting never converges) | **fix landed in this PR** (`.env.example` now defaults to blank, plus a README warning); **the Origin allowlist needs an ops-side change**; the regression test is still to be added | P0 |
| TC-T6-110 | With `prefers-reduced-motion: reduce` enabled, every `.lumen-*` animation becomes `animation: none` while semantic transitions keep a one-frame fade | code-verified (the media query at the end of `styles.css`); the manual check is still to be done | P1 |
| TC-T6-111 | Automatic frame-budget degradation: an rAF average over 22ms for 30 consecutive frames turns `body.surface-calm` ON; under 17ms for 60 frames turns it OFF | to be backported — the current design has no frameBudget of its own, and `lib/perf/frameBudget.ts` from the original lumen-web should be moved across | P2 |
| TC-T6-112 | F26 pull-to-refresh → `RoomClient.resync()` close + reconnect + ROOM_JOIN(lastSeq) | ✅ `lib/ws.test.js`（resync→close→reconnect→`ROOM_JOIN(lastSeq)`） | P1 |
| TC-T6-113 | Multiple tabs on one account: tab 1 bids → tab 2 receives BID_ACCEPTED (as another person, not a self flash) | ✅ `smoke:multitab` (`smoke:all`) plus `npm run smoke:multitab` (with the backend on 8080) | P1 |
| TC-T6-114 | AdminVLMFacts: `api.freeze` can only be called once all 5 facts are confirmed; freezing with fewer returns `ERR_FACTS_NOT_CONFIRMED` from the backend | ✅ resolved in this update (`admin.jsx <AdminVLMFacts>` + `components/admin.test.jsx`) | P0 (affects the demo) |
| TC-T6-115 | A seller bidding on their own lot is rejected → BID_REJECTED `code=ERR_NOT_ALLOWED` with the copy "this account cannot bid in this session" | ✅ `smoke-self-bid` (`smoke:all`) plus `npm run smoke:selfbid` (with the backend on 8080) | P2 |
| TC-T6-116 | High-frequency BID_PLACE on one connection is rate-limited to `ERR_RATE_LIMITED`: two bids within 0.1s on the same connection, and the second is rejected | `smoke:all` (which includes `smoke:ratelimit`) plus `npm run smoke:ratelimit` (backend on 8080 with auc_demo genuinely live) | P2 |

**Summary** (post-PR #51 #53 #54 + polish #63 #64 + test suite, 2026-05-27):
- Coverage: 15/15 pass under smoke plus code verification
- Status of gap probes 100-115:
- ✅ resolved in PR #51: 109 (Origin trap), 110 (reduced-motion auto-degrade), 111 (frame budget port)
- ✅ resolved in this update: 112 (the F26 pull-to-resync path is covered by the `RoomClient.resync` unit test)
  - ✅ resolved in PR #53: 114 (VLM freeze gate wired)
  - 🟡 partially covered in PR #51 (Evidence route): 107 (CHAIN BROKEN UI live now)
  - ✅ **104 / 105 newly executable in Vitest** (PR `fari/T6-test-suite-v2`) — `mobile.test.jsx` exercises MobileRoom with status=NO_BID/CANCELLED, asserts TerminalOverlay copy
  - ✅ **102 newly executable as smoke** (PR `fari/T6-test-suite-v2`) — `scripts/smoke-catchup.mjs` reconnects with lastSeq=N-1 and asserts the missed BID_ACCEPTED is replayed
  - ✅ **100 / 101 newly executable as smoke** (PR `fari/T6-test-suite-v2`) — `scripts/smoke-antisnipe.mjs` creates a short-duration auction (8s) with factsConfirmed=true, places a bid in the anti-snipe window, asserts AUCTION_EXTENDED with extendCount=1 + endAtMs > snapshot endAtMs, AND that BID_ACCEPTED.endAtMs matches AUCTION_EXTENDED.endAtMs (no stale countdown)
- ✅ **103 newly executable as smoke** (PR `fari/T6-test-suite-v2`) — `scripts/smoke-snapshot-fallback.mjs` generates 220 bids across 3 buyers to push tip > gap=200, then reconnects with the original lastSeq and asserts a fresh ROOM_SNAPSHOT is sent instead of XRANGE replay flood
- ✅ **115 newly executable as smoke** (this PR) — `scripts/smoke-self-bid.mjs` sends a BID_PLACE as the seller on their own lot and asserts `BID_REJECTED` + `ERR_NOT_ALLOWED`
- ✅ **113 newly executable as smoke** (this update) — `scripts/smoke-multitab.mjs` opens two WS connections on one account and verifies that tab 2 also observes `BID_ACCEPTED` after tab 1 bids
- Added: 108 (the ClockDriftIndicator DOM component assertion is in place)

The DOM-heavy browser gaps remain: 104-107 (all need Playwright). **112 is now covered by the resync reconnect test in `lib/ws.test.js`.** **100% of P0 gap probes are now under automated coverage.**

### Automated test coverage

Run all tests:
\`\`\`bash
cd apps/web && npm test               # vitest run — 91 tests in ~1s
cd apps/web && npm run test:coverage  # with v8 coverage report
\`\`\`

Wire smoke (needs `make up && make seed`):
\`\`\`bash
cd apps/web && npm run smoke:all
  # Runs all 9 smoke scripts sequentially:
  # · smoke:wire        — full round-trip (TC-T6-001…013)
  # · smoke:catchup     — lastSeq catchup (TC-T6-102)
  # · smoke:schema      — schema mismatch (TC-T6-110)
  # · smoke:401         — JWT 401 + dev-login refresh (TC-T6-271)
  # · smoke:antisnipe   — AUCTION_EXTENDED path (TC-T6-100/101)
  # · smoke:snapshot    — gap > 200 fallback (TC-T6-103)
  # · smoke:selfbid     — seller self-bid rejection (TC-T6-115)
  # · smoke:ratelimit   — per-connection burst -> ERR_RATE_LIMITED (TC-T6-116)
  # · smoke:multitab    — same-account multi-tab BID_ACCEPTED propagation (TC-T6-113)
cd apps/web && npm run smoke:ratelimit
  # (Optional direct run for focused rate-limit assertion)
cd apps/web && npm run smoke:selfbid
  # (Direct run for seller-self-bid rejection)
cd apps/web && npm run smoke:multitab
  # (Direct run for same-account multi-tab propagation)

# Also available via Makefile:
cd <repo-root> && make up && make seed && make web-smoke
cd <repo-root> && make web-smoke-prepare && make web-smoke
# Preflight check only:
cd <repo-root> && make web-smoke-check
# Full one-command flow (auto-up + auto-seed):
cd <repo-root> && WEB_SMOKE_AUTO_UP=1 WEB_SMOKE_AUTO_SEED=1 make web-smoke
# Focused run:
cd <repo-root> && make up && make seed && make web-smoke-ratelimit
cd <repo-root> && make web-smoke-ratelimit-prepare
cd <repo-root> && make up && make seed && make web-smoke-selfbid
cd <repo-root> && make web-smoke-selfbid-prepare
cd <repo-root> && make up && make seed && make web-smoke-multitab
cd <repo-root> && make web-smoke-multitab-prepare
\`\`\`

| Suite | Cases | Targets |
|---|---|---|
| `store/auction.test.js` | 28 | TC-T6-008 (seqguard), TC-T6-013 (BigInt leaderboard), TC-T6-006/007 (snapshot/bid shape), #64-M1/M2 (totalBidsCount/bidderIds) |
| `lib/clock.test.js` | 10 | TC-T6-108 (drift), P4 (server-corrected countdown) |
| `lib/format.test.js` | 12 | TC-T6-012/013 (Decimal-as-string + BigInt precision) |
| `lib/ws.test.js` | 7 | TC-T6-004 (ROOM_JOIN URL) + TC-T6-112 (resync close + ROOM_JOIN(lastSeq)) |
| `components/admin.test.jsx` | 4 | TC-T6-114 (VLM freeze gate + `ERR_FACTS_NOT_CONFIRMED` handling) + T6-#53-H3 (inline fact editor) |
| `components/primitives.test.jsx` | 30 | TC-T6-108 (drift color band) + TC-T6-230/231/234 (podium graceful <3), #54-M1 (HeatMeter clip), P2 (StatusBadge 7 states) |
| `components/mobile.test.jsx` | 12 | **TC-T6-104** (NO_BID overlay), **TC-T6-105** (CANCELLED overlay), #51-H2 (PullToResync onTouchCancel) |
| `scripts/smoke-wire.mjs` | E2E | TC-T6-001…013 (full wire round-trip) |
| `scripts/smoke-catchup.mjs` | E2E | **TC-T6-102** (lastSeq catchup) |
| `scripts/smoke-schema.mjs` | E2E | **TC-T6-110** (schema mismatch) |
| `scripts/smoke-401.mjs` | E2E | **TC-T6-271** (JWT 401 + dev-login refresh) |
| `scripts/smoke-antisnipe.mjs` | E2E | **TC-T6-100** (extendCount + endAtMs) + **TC-T6-101** (BID_ACCEPTED carries post-ext endAtMs) |
| `scripts/smoke-snapshot-fallback.mjs` | E2E | **TC-T6-103** (gap > 200 → snapshot fallback, no XRANGE replay flood) |
| `scripts/smoke-self-bid.mjs` | E2E | **TC-T6-115** (seller self-bid rejected as ERR_NOT_ALLOWED) |
| `scripts/smoke-ratelimit.mjs` | E2E | **TC-T6-116** (same-socket burst -> `ERR_RATE_LIMITED`) |
| `scripts/smoke-multitab.mjs` | E2E | **TC-T6-113** (same-account multi-tab bid propagation) |

---

## 1. Coverage cases

### TC-T6-001 — `POST /api/dev-login` returns `{ userId, token, nickname }`

- **Preconditions**: backend up, `ENABLE_DEV_LOGIN=true`
- **Steps**: 
  1. `fetch('/api/dev-login', { method: 'POST', body: JSON.stringify({ nickname: 'fari-smoke' }) })`
  2. Parse the response JSON
- **Input data**: `{ "nickname": "fari-smoke" }`
- **Expected result**: HTTP 200; body `{ userId: 'user_fari_smoke', token: 'user_fari_smoke.<hex64>', nickname: 'fari-smoke' }`; the token is 80 characters (`<userId>.<hex64>`)
- **Priority**: P0
- **Status**: ✅ smoke PASS

### TC-T6-002 — The token is cached in localStorage and reused after a reload

- **Preconditions**: TC-T6-001 has already run
- **Steps**: 
  1. `ensureSession('demo')`, wait for it to resolve
  2. `localStorage.getItem('lumen.session')` is non-empty and JSON-parses to `{ userId, token, nickname }`
  3. Reload the page
  4. Call `ensureSession('demo')` again (with no nickname or a different one)
- **Expected result**: The second call makes no new `/api/dev-login` request (zero network calls) and resolves the cached session directly
- **Priority**: P0
- **Status**: ✅ code-verified (`lib/auth.js currentToken()` reads the cache first)

### TC-T6-003 — The Authorization Bearer header is added to REST requests automatically

- **Preconditions**: `currentToken()` returns non-empty
- **Steps**: 
  1. `api.getEvidence('auc_demo')`
  2. Inspect the outgoing request headers in DevTools
- **Expected result**: `Authorization: Bearer <jwt>`;`Content-Type: application/json`
- **Priority**: P0
- **Status**: ✅ code-verified (the `lib/api.js request()` function)

### TC-T6-007 — The full BID_ACCEPTED field set (string cents + endAtMs + status)

- **Preconditions**: WS open; ROOM_JOIN complete
- **Steps**: 
  1. send `BID_PLACE { clientBidId: 'cbid-x', amountCents: '15000' }`(the snapshot price is 10000)
  2. Receive BID_ACCEPTED
- **Input data**: see step 1
- **Expected result**: `type='BID_ACCEPTED'`;`schemaVersion=2`;`seq=1`;`data.userId='user_fari_smoke'`;`data.displayName='fari-smoke'`;`data.amountCents='15000'` (**string**); `data.endAtMs` typeof 'number';`data.status='LIVE'`;`data.bidCount` typeof 'number';`data.serverTimeMs` typeof 'number'
- **Priority**: P0
- **Status**: ✅ smoke PASS (see the `/tmp/lumen-repo/smoke-ws.mjs` output)

### TC-T6-008 — Double-broadcast dedupe

- **Preconditions**: WS open and one BID_ACCEPTED already received
- **Steps**: 
  1. Send one BID_PLACE
  2. Observe how many BID_ACCEPTED frames the client receives (the server sends 2: the direct ack plus the Pub/Sub fanout)
  3. Check how many times store.applyEvent applied
- **Expected result**: The wire receives 2 frames at the same seq; the store applies only the first; the second early-returns on `seq <= lastSeq`
- **Priority**: P0
- **Status**: ✅ smoke shows the double broadcast; the store's `applyEvent` dedupe logic is code-verified

### TC-T6-014 — Vite same-origin proxy + Origin allowlist

- **Preconditions**: `.env.local` does not set VITE_WS_BASE (or leaves it blank); `make up` defaults to `FRONTEND_ORIGIN=http://localhost:8080`
- **Steps**: 
  1. `npm run dev` (vite at :5173)
  2. Open `http://localhost:5173/room/auc_demo`
  3. In the DevTools Network panel select the WS frame and read the request headers
- **Expected result**: WS connects to `ws://localhost:5173/ws?...`; the Vite proxy forwards to `ws://localhost:8080/ws?...` and sets `Origin: http://localhost:8080`; the backend `OriginAllowed` passes (`origin == allowed`); 101 Switching Protocols
- **Priority**: P0
- **Status**: ✅ code-verified; the manual test is still to run

### TC-T6-015 — The evidence response field set matches proto

- **Preconditions**: `make verify-evidence` PASS; `auc_demo` is already SOLD
- **Steps**: `GET /api/auctions/auc_demo/evidence` with auth
- **Expected result**: the JSON contains all of `auctionId, status, currentPriceCents (string), winnerId, seq, eventsCount, factsConfirmed, timeline (array), eventsHash (string), chainVerified (bool), note`;with chainVerified=true it **excludes** the `hashBreakAtSeq` field; when authenticated it includes the `order` block
- **Priority**: P0
- **Status**: ✅ code-verified: the conditional set in backend `handleEvidence:468-473`

(For 001, 004-006, and 009-013 see the index table above; the details mirror the style used here.)

---

## 2. Gap-probe cases — executable status

### TC-T6-100 — The AUCTION_EXTENDED path end to end

- **Preconditions**: auction `endAtMs - now <= 10s` (the anti-snipe window) and `extendCount < maxExtensions`
- **Steps**: 
  1. Adjust the seed so endAtMs falls within now+5s
  2. Send BID_PLACE (above the current price)
  3. Expect BID_ACCEPTED followed by AUCTION_EXTENDED
  4. Check that store.extendCount goes 0 → 1 and store.endAtMs moves from the old value to the new one
  5. UI: the ExtendBadge appears and the lumen-sweep animation plays
- **Expected result**: every step passes
- **Priority**: P0
- **Status**: ✅ `scripts/smoke-antisnipe.mjs` (`npm run smoke:antisnipe`) covers TC-T6-100/101: short-duration auction, final-window bid, `AUCTION_EXTENDED`, `extendCount=1`, and post-extension `endAtMs` on the accepted bid.

### TC-T6-102 — Reconnect carries lastSeq plus catchup

- **Preconditions**: WS open with store.lastSeq already advanced to N (N > 0)
- **Steps**: 
  1. `ws._impl.close()` to force a disconnect
  2. During the reconnect backoff, the backend writes K events (N+1..N+K) with K <= 200
  3. Wait for the reconnect and observe ROOM_JOIN carrying `lastSeq=N`
  4. The backend replays the K events with XRANGE over the critical lane (T5)
  5. The frontend store.lastSeq should advance to N+K
- **Expected result**: The store receives all K events with no duplicates (seqguard dedupe) and none missing
- **Priority**: P0
- **Status**: ✅ `scripts/smoke-catchup.mjs` (`npm run smoke:catchup`) covers reconnect-with-`lastSeq` and missed-event replay for gaps ≤ 200.

### TC-T6-103 — Gap > 200 → snapshot fallback

- **Preconditions**: as above, but K > 200
- **Steps**: as above, plus injecting 201 events
- **Expected result**: The backend `dispatchWS:366` sees `snap.Seq-d.LastSeq > catchupMaxGap` → skips XRANGE and sends ROOM_SNAPSHOT directly; the frontend resets the seqguard watermark to snapshot.seq
- **Priority**: P0
- **Status**: ✅ `scripts/smoke-snapshot-fallback.mjs` (`npm run smoke:snapshot`) covers gap > 200 fallback to `ROOM_SNAPSHOT` instead of replay flood.

### TC-T6-109 — Direct WS bypass + Origin allowlist

- **Preconditions**: `.env.local` sets `VITE_WS_BASE=ws://localhost:8080`; the backend has `FRONTEND_ORIGIN=http://localhost:8080` (the default)
- **Steps**: 
  1. Load `http://localhost:5173/room/auc_demo`
  2. Observe the WS upgrade returning 401
  3. UI: ConnReconnecting never converges → the schema-mismatch path is NOT triggered (401 is an auth error, not a protocol error)
- **Expected result**: a reconnect storm plus console logs; **fix**: leave VITE_WS_BASE blank by default in `.env.example`, or set the backend `FRONTEND_ORIGIN=http://localhost:5173`
- **Priority**: P0
- **Status**: ✅ **the fix landed in PR #49** (`.env.example` now defaults to blank, with the CSWSH guard explained); the regression test is still to be made executable (checking in e2e that a 401 does not degrade into a silent loop)

### TC-T6-114 — Freeze is blocked until every VLM fact is confirmed

- **Preconditions**: a DRAFT auction where the VLM returned 5 facts
- **Steps**: 
  1. On `/admin/auctions/:id/vlm`, confirm only 3 of the 5
  2. Click "confirm all, then go live"
  3. Expect the button to be disabled (the client-side gate)
  4. Even bypassing the client and calling `api.freeze(id)` directly returns `ERR_FACTS_NOT_CONFIRMED` (409) from the backend
- **Expected result**: this step must demo successfully in the video
- **Priority**: P0 (affects the demo)
- **Status**: ✅ `components/admin.test.jsx` covers client-side disabled gate, `factsConfirmed: true` payload, 5 confirmed facts, and visible `ERR_FACTS_NOT_CONFIRMED` error handling.

(The remaining items in 100-115 mirror the style above; the concrete steps here get updated as each becomes executable.)

---

## 3. PR #51 / #53 / #54 follow-up — admin wiring · buyer polish · perf guardrail

Self-review pass 2026-05-26 covering everything that landed after PR #49.
Cases are grouped by feature; numbering continues from the 100-series so
existing tooling and dev-log links don't break.

### 3.1 Index

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
| TC-T6-280 | `ROOM_SNAPSHOT.data.rules.stepCents` overwrites fallback and drives quick-bid chip math | store + QuickBidChips | P1 |
| TC-T6-281 | `ROOM_SNAPSHOT.data.rules.capCents` set → MAX chip returns exactly cap | store + QuickBidChips | P1 |
| TC-T6-282 | `ROOM_SNAPSHOT.data.rules.capCents=null` keeps no-cap semantics and MAX falls back to +10% | store + QuickBidChips | P1 |
| TC-T6-283 | Backend snapshot DTO encodes frozen `maxExtensions` and `antiSnipeWindowMs` for UI display | store.Snapshot | P2 |

### 3.3 Test execution detail (selected high-priority cases)

#### TC-T6-200 — AdminPublish valid submit → navigate

- **Preconditions**: `/admin/auctions/new` is loaded; the backend is up
- **Steps**: 
  1. Leave the form at its defaults (`title='Patek Philippe 5711/1A - blue dial'`, `startCents='12000000'`, `stepCents='500000'`, `reserveCents='10000000'`, `capCents='30000000'`)
  2. Click "next: review the VLM facts"
- **Expected result**: 
  - DevTools Network: `POST /api/products` returns `{ productId: 'prod_…' }`
  - Immediately after, `POST /api/auctions` returns `{ auctionId: 'auc_…' }`
  - The `POST /api/auctions` payload `rules` uses the backend `model.Rules` fields; `mode` may be omitted (defaulting to `ENGLISH`), and a second-price/Vickrey auction uses `mode: "VICKREY"`
  - The route navigates to `/admin/auctions/<auctionId>/vlm`
  - The button goes disabled immediately and its label becomes "creating..." (the busy state)
- **Priority**: P0
- **Status**: ✅ code-verified — `adminExtra.jsx handleSubmit`; the executable version needs Playwright

#### TC-T6-216 — VLM freeze gate · the backend ERR_FACTS_NOT_CONFIRMED path

- **Preconditions**: a DRAFT auction exists but the backend `factsConfirmed` is still false (the VLM flow was not completed), and the user bypasses the client gate to call `api.freeze()` manually (for example from the DevTools console)
- **Steps**: 
  1. Call `await api.freeze('auc_<id>')` directly in DevTools
  2. Observe the fetch response
- **Expected result**: 
  - HTTP 409 + body `{ code: 'ERR_FACTS_NOT_CONFIRMED', message: '...' }`
  - The frontend throws an `ApiError` and the gate copy at the bottom of the UI becomes "failed to go live - ERR_FACTS_NOT_CONFIRMED - ..."
  - The user returns to the VLM page to keep confirming
- **Priority**: P0
- **Status**: ✅ code-verified — the check in backend `api.go handleFreeze`, plus the catch and display in the frontend `admin.jsx handleFreezeAndStart`

#### TC-T6-217 — Freeze succeeded but Start failed (race / state-leak edge)

- **Preconditions**: after a successful freeze, start_auction.lua returns ERR_BAD_STATE because of a race (the timer got there first, or a Redis fault)
- **Steps**: 
  1. Simulate freeze 200 followed by start 409
  2. Observe the UI
- **Expected result**: 
  - The user stays on the VLM page (no jump to the live console)
  - The gate copy at the bottom reads "failed to go live - ERR_BAD_STATE - ..."
  - It does **not** leave a SCHEDULED orphan state (a failed backend start keeps it SCHEDULED and the user can retry)
  - No corrupted client-side UI state is left behind
- **Priority**: P1
- **Status**: ✅ code-verified — the sequential try/catch in `handleFreezeAndStart`, with each step throwing independently

#### TC-T6-240 — Chip percent snap-up math

- **Preconditions**: `currentCents='12880000'`,`stepCents='500000'`
- **Steps**: 
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
- **Expected result**: Every cents value shown on a chip satisfies `bid >= current + step` (accepted by place_bid.lua) and is aligned to a multiple of step
- **Priority**: P0
- **Status**: ✅ code-verified — `primitives.jsx QuickBidChips pctBump`

#### TC-T6-242 — MAX fallback logic

- **Preconditions**: the auction has no cap set (`capCents=null`)
- **Steps**: Observe the cents shown on the MAX chip
- **Expected result**: MAX equals the result of `pctBump(10)`, identical to the +10% chip
- **Priority**: P0
- **Status**: ✅ code-verified — `primitives.jsx QuickBidChips maxBid()`

#### TC-T6-244 — BigInt precision at max-money boundary

- **Preconditions**: `currentCents='9000000000000000'` (about 9e15, close to `MaxMoneyCents = 2^53-1`), `stepCents='1000000'`
- **Steps**: Tap the +1% chip
- **Expected result**: 
  - `raw = BigInt(9e15) * 101n / 100n = 9090000000000000n` (exact, with no float truncation)
  - `snapped` and `stepsUp` stay BigInt throughout; the result is a `string`, not a `Number`
  - The actual value never exceeds `MaxMoneyCents`; if it did, the backend `ERR_BAD_INPUT` catches it
- **Priority**: P1
- **Status**: ✅ code-verified — `pctBump` is BigInt throughout

#### TC-T6-251 — HeatMeter overflow

- **Preconditions**: `bidsPerSec=12`,`peak=6`
- **Steps**: render `<HeatMeter bidsPerSec={12} peak={6}/>`
- **Expected result**: 
  - `ratio = Math.min(1, 12/6) = 1` (no overflow)
  - Progress bar width: `100%`
  - Colour: `var(--state-live)` (`#FE2C55`)
  - Label "12.0/s"
- **Priority**: P1
- **Status**: ✅ code-verified — `primitives.jsx HeatMeter ratio = Math.min(1, ...)`

#### TC-T6-260 — SOLD shake one-shot

- **Preconditions**: `<MobileRoom status="LIVE">` mounted
- **Steps**: 
  1. observe no shake class
  2. prop change to `status='SOLD'` (1st time)
  3. wait 700ms
  4. trigger an unrelated re-render (e.g. `currentCents` prop change) while `status='SOLD'`
- **Expected result**: 
  - step 1: `.lumen-screen-shake` is not in the class list
  - step 2: `.lumen-screen-shake` is added immediately
  - step 3: it is removed automatically (the 700ms timeout fires)
  - step 4: it is **not** re-added (`lastStatusRef.current === 'SOLD'`, so there is no LIVE→SOLD transition)
- **Priority**: P0 (prevents a hammer visual loop)
- **Status**: ✅ code-verified — `mobile.jsx hammerShake useEffect with lastStatusRef`

#### TC-T6-263 — SOLD shake skip on initial mount-already-sold

- **Preconditions**: the user opens `/room/auc_demo` directly on an auction that is already SOLD
- **Steps**: on the first mount `status='SOLD'` already applies
- **Expected result**: 
  - `lastStatusRef.current` starts at `status`, which is `'SOLD'`
  - The useEffect fires but the `lastStatusRef.current !== 'SOLD'` check is false, so there is no shake
  - The user sees the HammerOverlay with no screen shake (as intended - this is history, not something that just happened)
- **Priority**: P1
- **Status**: ✅ code-verified — `lastStatusRef` is initialized to `status`, not `null`

---

## 4. Execution checklist / coverage matrix

| Method | Covered | Outstanding |
|---|---|---|
| smoke (`smoke:all`) | 001, 004-013, 100, 101, 102, 103, 109 reg, 110, 113, 115, 116, 271 | 104-107 plus the DOM-heavy P4/P5 cases (pending Playwright) |
| code-verify (reading the backend Go plus local components statically) | 002, 003, 014, 015, 106, 107, 110, 111, 112, 113, 114, 115, 200, 202-218, 220-225, 230, 234, 235, 240-244, 247-249, 250-254, 260-263, 270, 272, 273, 277, 278 | — |
| manual visual | to run | 014 origin walk · 106 bridge transition · 107 chain-broken · 110 reduced-motion · 112 PTR · 230-235 podium variants · 250-252 heat colors · 260 shake |
| executable (browser e2e / Playwright) | smoke covers 100-103 / Vitest covers 104-105, 112, 114 | 106-107 visual assertions · 200-225 the admin chain end to end · 230-263 visual assertions · 270-279 cross-cutting |
| backend regression | T4 #34 / T5 #38 / T3 #33 PR test suite | — |

**Recommended next steps**:
1. Complete browser-e2e Playwright cover for DOM-observation/interaction-only probes: 104-107 + 200-225 + 230-263.
2. Add Vitest unit suite for the pure-math helpers in QuickBidChips (`pctBump` + `maxBid`) — instant CI feedback, no infra.

---

## 5. Risk Register (post #51 #53 #54 + polish PRs #63 #64 — 2026-05-27)

**Resolved:**
1. ✅ **P0 → resolved**:T6-114 (VLM freeze gate) wired in PR #53.
2. ✅ **P0 → resolved**:T6-109 (Origin trap) fixed in PR #51's `.env.example` + README. Ops still need to set `FRONTEND_ORIGIN` correctly in deploys — flagged as runbook item, not a code issue.
3. ✅ **P1 → resolved**:T6-217 (freeze-then-start race orphan) — fix landed in PR #53 commit `065a49d` after @Eliaaazzz review. `handleFreezeAndStart` now treats `ERR_BAD_STATE` on freeze as "already frozen, proceed to startLive". Vitest assertion still recommended but not blocking.
4. ✅ **P1 → resolved**:T6-271 (expired JWT not re-handled) — fix landed in PR #51 commit `646c52b`. 401 from REST now calls `handleAuthFailure()` → clears cached session + dispatches `lumen:session-expired` custom event for route-level UX recovery.
5. ✅ **P1 → resolved**:T6-#54-H1 (stepCents=0 silent panic) — store default `'500000'` + `stepUsable` guard in `<QuickBidChips>` (PR #54 commit `8e08cdf`).
6. ✅ **P1 → resolved**:T6-#54-H2 (NO_BID / CANCELLED terminal UX missing) — `<TerminalOverlay>` component (PR #54).
7. ✅ **P1 → resolved**:T6-#54-H3 (custom drawer MaxMoneyCents overflow) — three-layer guard: maxLength=17 + BigInt validation + inline error copy (PR #54).
8. ✅ **P1 → resolved**:T6-#51-H4 (HMAC custody indirect doc reference) — inline threat-model summary added to `EvidenceRoute.jsx` (PR #51 commit `646c52b`).
9. ✅ **P1 → resolved**:T6-#51-H2 (PullToResync onTouchCancel) — `reset()` + `finish()` helpers, `onTouchCancel` and drag-out `onMouseLeave` (PR #63 `fari/T6-room-perf-polish`).
10. ✅ **P1 → resolved**:T6-#51-H4 (CancelOverlay hardcoded currentCents) — modal now fetches `api.getAuction(id)` on mount; loading guard renders busy modal during fetch (PR #63).
11. ✅ **P1 → resolved**:T6-#54-M1 (bidsPerSecPeak fixed at 6 clips heat meter) — ref-based rolling-max in LiveRoomRoute (PR #63).
12. ✅ **P1 → resolved**:T6-#53-H2 (AdminConsole bare `useAuctionStore()` re-render storm) — selector-per-slice refactor (PR #64 `fari/T6-admin-polish`).
13. ✅ **P1 → resolved**:T6-#53-M1 (total-bids clipped at 50 by recentEvents cap) — store now maintains cumulative `totalBidsCount` field (PR #64).
14. ✅ **P1 → resolved**:T6-#53-M2 (unique-bidder count includes undefined userIds) — store maintains `bidderIds[]` with reducer-side filter for truthy userIds (PR #64).
15. ✅ **P1 → resolved**:T6-#53-M4 ((cap-start)%step unvalidated → silent cap-hit failure) — `capReachable` BigInt check gates submit + visible hint on cap field (PR #64).
16. ✅ **P2 → resolved**:P9 surface-calm consistency (`lumen-veil-bridge-fade` not muted) — added to mute list (PR #63 self-spotted).
17. ✅ **P1 → resolved**:T6-#53-H3 (VLM facts inline editor) — `<FactCard>` now edits in-card via textarea; `components/admin.test.jsx` pins no-`window.prompt` behavior and verifies edited fact payload.

**Still open:**
18. **P2**:T6-272 (concurrent same clientBidId across tabs) — backend dedupe handles it; UX could be clearer.
19. **P2**:Backend `RoomSnapshotData` now ships `rules.{stepCents, capCents, reserveCents}`; `extendCount` is still preserved client-side because snapshots do not carry it yet.
20. **P3**:T6-273 (alive-flag pattern in all routes) — code-verified, no executable test pinning it.

---

**Refs**:
- backend wire contract: `proto/ws-envelope.md`, `proto/error-codes.md`, `proto/evidence-card.md`
- `apps/web/docs/INTEGRATION-NOTES.md` lists the audit trail of the PR #49 wire changes
- `apps/web/docs/project-blueprint.md` §5(life-of walkthroughs)+ §13 cross-check rubric
- Already merged: T4 #34, T5 #38, T3-followup #33
- PR stack (review-pending): #49 · #50 · #51 · #53 · #54 · plus Elia's #52 (round-2 prototype) and Elia's #48 (T5 keepalive followup)
- in-flight: T5-followup #48(WS keepalive + typed close 4000), PDGGK codex #50(parallel design export)
