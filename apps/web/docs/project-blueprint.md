# Lumen Auction — Project Blueprint

> **What this document is for.** A complete, structural read-out of the project as it stands on **2026-05-25**: every layer, every boundary, every shipped/in-flight PR, the full frontend functional scope, and the exact wire-level mechanics of frontend↔backend integration. Use it as the source-of-truth cross-check against any design proposal (e.g. those produced by `/frontend-design` from `design-system.md`).
>
> **Companion docs**: `design-system.md` is the **design** brief (visual/aesthetic/principles). This is the **engineering** spec. Together they cover what the design must look like and what it must do.

---

## §0 How to use this document

When a design proposal arrives, walk through it with this doc open:

| To verify | Look in |
|---|---|
| Project surfaces and which are P0 | §3 |
| Every wire event the design must handle | §4 |
| The exact life-cycle of a bid / a hammer / a reconnect | §5 |
| Whether every visible feature maps to a backend invariant | §6 |
| Whether the design respects performance constraints | §8 |
| Whether the demo storyline is supportable in 30 seconds silent | §9 |
| Whether anything blocks integration | §10, §11 |

When you start implementation work, use §2 to know which T-tier you're in, §3 to know what's left in scope, §5 for how each interaction is wired, and §12 as the merge-readiness checklist.

---

## §1 Project topology — the 9 engineering boundaries

Lumen Auction is structured around 9 frozen architectural boundaries (Plan V9 §0 / RFC v2 §0). The frontend is one of them. The boundaries are not negotiable — they were ratified before T1, and design proposals must honor them.

```
        ┌─────────────────────────────────────────────────────────────┐
        │                     CLIENTS                                 │
        │  ┌─────────────────────┐  ┌─────────────────────────────┐   │
        │  │ Mobile H5 (Buyer)   │  │ PC Admin (Seller/Broadcast) │   │
        │  └─────────┬───────────┘  └────────────┬────────────────┘   │
        │            │                           │                    │
        │            ▼                           ▼                    │
        │   ┌───────────────────────────────────────────────────┐     │
        │   │   ① WebSocket Gateway   (NOT authoritative)       │     │
        │   │       multi-instance horizontal; routes rooms     │     │
        │   │       reads canonical Stream for fan-out          │     │
        │   └────┬─────────────┬─────────────────────┬──────────┘     │
        │        │ POST /bid   │ HTTP REST           │ WS broadcast   │
        │        ▼             ▼                     ▲                │
        │   ┌────────────┐  ┌──────────────────┐  ┌──┴──────────────┐ │
        │   │ ② Bid      │  │ HTTP API handler │  │ ⑦ Redis (single │ │
        │   │   Engine   │──▶  (auction CRUD)  │──▶    primary)     │ │
        │   │ single-inst│  └──────────────────┘  │   state Hash    │ │
        │   │ ONLY caller│                        │   Stream <seq>-0│ │
        │   │ of *.lua   │                        │   dedupe Hash   │ │
        │   └────────────┘                        │   auction:active│ │
        │                                         └──┬──────────────┘ │
        │                                            │                 │
        │   ┌──────────────┐   ┌─────────────────────┴─────────────┐  │
        │   │ ③ Timer      │──▶│  Lua scripts ONLY mutate state:    │  │
        │   │   Worker     │   │  place_bid · close_auction ·       │  │
        │   │ scans 100ms  │   │  cancel_auction · start_auction ·  │  │
        │   │ ZSET auction:│   │  freeze_rules                       │  │
        │   │ active       │   └─────────────────────────────────────┘  │
        │   └──────────────┘                                            │
        │                                                               │
        │   ┌──────────────┐   ┌─────────────────────────────────────┐  │
        │   │ ④ Persistence│──▶│  ⑧ MySQL 8                          │  │
        │   │   Worker     │   │  facts · auctions · auction_events  │  │
        │   │ Stream → DB  │   │  orders (UNIQUE auction_id)         │  │
        │   │ idempotent   │   │  event_hash + prev_hash chain       │  │
        │   │ writes hash  │   └─────────────────────────────────────┘  │
        │   │ chain        │                                            │
        │   └──────────────┘                                            │
        │                                                               │
        │   ┌─────────────┐                                             │
        │   │ ⑤ Order Svc │  (terminal SOLD → idempotent order create) │
        │   └─────────────┘                                             │
        │                                                               │
        │   ⑥ State Machine — pure fns; canonical 7 states; no I/O      │
        │                                                               │
        │   ┌─────────────────────────────────────────────────────────┐ │
        │   │ ⑨ AI Sidecar (NON-authoritative, separate process)      │ │
        │   │   POST /facts/draft  — VLM (T1 mock, T7 Doubao)         │ │
        │   │   LLM auctioneer 4 triggers (T7) — never blocks bidding │ │
        │   └─────────────────────────────────────────────────────────┘ │
        └─────────────────────────────────────────────────────────────────┘
```

### §1.1 Authority semantics — who owns truth

| Boundary | Authority over | Frontend treats as |
|---|---|---|
| **Lua scripts** (place_bid, close_auction, cancel_auction, start_auction) | All state mutations | Source of truth — anything else is a projection |
| **Redis Stream** (`<seq>-0` ID format) | Canonical event log | Frontend reads via WS broadcast; `seq` ordering is mandatory |
| **Redis state Hash** (`auction:{aid}:state`) | Live current value | Cached snapshot; never poll, listen to Stream |
| **MySQL projection** (auction_events, orders) | Recoverable history + evidence | Read for evidence card via REST; never for live state |
| **WS Pub/Sub** | Wakeup hint only | Frontend **never** consumes — gateway reads Stream to broadcast |
| **WS Gateway** | Connection routing + fan-out | Frontend connects here; gateway has no state authority |
| **AI Sidecar** | Suggestions only | Frontend renders if available; bidding continues if absent |
| **Video** | Visual atmosphere only | Frontend renders; never derives price/time/winner from it |

### §1.2 Hot path vs cold path

**Hot path** (must be sub-second, Lua-atomic, Stream-broadcast):
- `BID_PLACE` → `place_bid.lua` → `BID_ACCEPTED` ack + Stream broadcast → all room clients receive
- Timer expiry → `close_auction.lua` → `AUCTION_SOLD`/`AUCTION_NO_BID` Stream broadcast
- Seller cancel → `cancel_auction.lua` → `AUCTION_CANCELLED` Stream broadcast

**Cold path** (HTTP REST, not on the bidding critical loop):
- `POST /api/auctions` (publish)
- `POST /api/auctions/:id/freeze` (DRAFT → SCHEDULED)
- `POST /api/auctions/:id/start` (SCHEDULED → LIVE)
- `POST /api/auctions/:id/cancel` (admin-initiated cancel)
- `POST /api/facts/draft` (VLM)
- `GET /api/auctions/:id/evidence` (post-hammer)
- `GET /api/auctions/:id/leaderboard` (top-N snapshot)
- `POST /api/dev-login` (session bootstrap)

---

## §2 T0–T10 status — what's shipped, in flight, planned

The project is structured as **trunk steps** (T0–T10), one per demo-path node. Source: Plan V9 §10 + roadmap.md.

| T | Window | Owner | Status | Evidence |
|---|---|---|---|---|
| **T0a** | 5/22–23 | Eliaaazzz | ✅ MERGED | Contracts authored: `proto/{openapi.yaml, ws-envelope.md, redis-keys.md, ai-events.md, db-schema.md, error-codes.md, evidence-card.md, security-baseline.md}` |
| **T0b** | 5/23–24 | Eliaaazzz | ✅ MERGED | `make up` green; `infra/docker-compose.yml`; CI gates active |
| **T1** | 5/23–25 | Eliaaazzz | ✅ MERGED (PR #19; issue #17 closed) | Dummy bid roundtrip e2e: seller create → mock VLM → freeze → start → 1 bid → ack + broadcast → MySQL persist |
| **T2** | ~5/27 | Eliaaazzz | ✅ MERGED via #31 rollup (atomic bid core PR #26 + hidden tests #27/#28) | `place_bid.lua` return-codes; leaderboard ZSET; seq-guard; concurrency suite |
| **T3** | ~5/28 | Eliaaazzz | ✅ MERGED via #31 + #33 follow-up | Timer Worker hammer; anti-snipe extend; cancel from any source state; gap-probe CI gates (TC-T3-100/103/104/105) |
| **T4** | ~5/29 | Eliaaazzz | 🟡 OPEN PR #34 — persistence hash chain + idempotent order + evidence card v0; #35 docs PR open; follow-up issue #37 (caching, key rotation) |
| **T5** | ~5/30–31 | Eliaaazzz | 🟡 OPEN PR #38 — backpressure channel split + multi-gateway fanout; #39 test-case doc open |
| **T6** | ~5/31 | TBD | ⬜ NOT STARTED — Replay Verifier (Stream/Redis/MySQL three-way `consistent`) |
| **T7** | ~6/01 | TBD | ⬜ NOT STARTED — AI sidecar full: real Doubao VLM + LLM auctioneer 4 triggers (currently T1 mock at `POST /facts/draft`) |
| **T8** | ~6/02–04 | TBD | ⬜ NOT STARTED — 500/50 pressure test + latency tune + Grafana dashboard |
| **T9** | ~6/05 | fariZzzz | 🟡 OPEN PR #24 — chaos-runner skeleton + 3 new diversification phases |
| **T10** | ~6/06→6/08 | TBD | ⬜ NOT STARTED — Demo materials: deploy, 3-min script, recording, README, dashboard screenshot, Verifier proof |

### §2.1 Frontend trunk view (parallel track to backend T-tiers)

Frontend work was scoped after T3 merged. **On 2026-05-26 a comprehensive 13-screen design pass landed** (React + Vite, see §14.5) and the wire layer was re-aligned to the backend's actual `proto/ws-envelope.md` + `proto/error-codes.md` contract. All FE screens now exist as static visual mocks; wiring to the live backend is what's left.

| FE Phase | Maps to backend T | Status | Surface |
|---|---|---|---|
| **FE-T0** (design pass) | — | ✅ landed 2026-05-26 — All 13 screens shipped as visual mockups (see §3) including bridge palette (A↔B crossfade), every atmosphere effect (F01–F15+), VLM Facts hero, Live Console mission control, Cancel 2-step modal, Publish form, Orders & GMV dashboard, Mini-program stub, all connection states |
| **FE-T6 wired** | T6 (room) | ✅ Room route `/room/:auctionId` wired end-to-end (dev-login → snapshot → leaderboard → ROOM_JOIN + WS); seqguard + clock-skew + reconnect all working |
| **FE-T4 wired** | T4 (evidence card) | 🟡 UI ready — `<MobileEvidence>` renders CHAIN VERIFIED / BROKEN variants from static data; needs `api.getEvidence()` call on route mount. **Timeline auto-populates after PR #34 merges** |
| **FE-T5a wired** | (admin standalone) | 🟡 UI ready — `<AdminVLMFacts>`, `<AdminConsole>`, `<AdminCancelModal>`, `<AdminPublish>` all exist; need `api.draftFacts` / `api.freeze` / `api.startLive` / `api.cancel` wiring on the route handlers |
| **FE-T5b wired** | (admin CRUD) | 🟡 UI ready — `<AdminOrders>` renders from static `ORDER_ROWS`; need `api.listAuctions` once backend ships it (P1 — currently mock-only) |
| **FE-T7 wired** | T7 (AI streaming) | 🟡 UI ready — `<AIBubble>` + `<TypewriterText>` ready for streaming; need T7 backend to expose LLM SSE/WS event channel |
| **FE-MiniStub** | (Mini-program) | ✅ visual at `/preview/mp` — `<MiniProgramStub>` renders "请在抖音 App 内打开" landing; deep-link wiring is a 2-line add when needed |

**Source of truth for wired state**: `src/routes/LiveRoomRoute.jsx` is the canonical example; all other routes follow the same pattern (ensure session → REST fetch → optional WS subscription).

### §2.2 Backend ↔ frontend dependency map

The frontend depends on backend trunk completion in this order:

```
T1 backend  ←  FE can render Room with bid roundtrip (DONE)
T2 backend  ←  FE can render leaderboard + extendCount (DONE)
T3 backend  ←  FE can render hammer/cancel terminal states (DONE; FE has UI for all 3)
T4 backend  ←  FE evidence timeline activates (FE READY, awaits #34 merge)
T5 backend  ←  FE catchup w/ multi-gateway + true 500-connect testing (FE has stub)
T7 backend  ←  FE AIBubble receives real LLM stream (FE has placeholder)
```

The frontend is currently **ahead** of T4/T5/T7 backend completion. This is intentional: each FE chunk is forward-compatible with the awaited backend.

---

## §3 Frontend scope — complete functional inventory

### §3.1 Surfaces

| Surface | Priority | Device | Status |
|---|---|---|---|
| **Mobile H5 — Room** | P0 | iPhone 13/14 (390×844), iPhone SE (375×667) baseline | Built (T6.0 + T6.1) |
| **Mobile H5 — Evidence card** | P0 | Same | Built (FE-T4) |
| **PC Admin — VLM facts confirmation** | P0 (hero) | Desktop 1440px+ | NOT STARTED |
| **PC Admin — Live broadcast console** | P0 | Desktop 1440px+ | NOT STARTED |
| **PC Admin — Auction publish form** | P0 | Desktop 1440px+ | NOT STARTED |
| **PC Admin — Cancel-with-confirm modal** | P0 | Desktop 1440px+ | NOT STARTED |
| **PC Admin — Orders & Products CRUD** | P1 | Desktop 1440px+ | NOT STARTED |
| **PC Admin — Evidence detail (export PDF)** | P1 | Desktop 1440px+ | NOT STARTED |
| **Mini-program — Stub landing** | P0 (OPEN DECISION C) | Mobile inside Douyin App | NOT STARTED |

### §3.2 Mobile H5 — Room (P0)

Required functionality, in order of dependence:

| Capability | Wire dependency | Status |
|---|---|---|
| Bootstrap dev-login session | `POST /api/dev-login` | ✅ |
| Open WS connection with auth | `WS /ws?auction=...&token=...` | ✅ |
| Send `ROOM_JOIN` with optional `lastSeq` | client→server | ✅ |
| Receive `ROOM_SNAPSHOT` and initialize | server→client | ✅ |
| Maintain `serverClockOffsetMs` on every envelope | computed from `serverTimeMs` | ✅ |
| Display canonical status (one of 7) | from `ROOM_SNAPSHOT.status` + transitions | ✅ |
| Display current price (Decimal-string render) | from `currentPriceCents` | ✅ |
| Live countdown with self-correcting clock | `endAtMs - (clientNow + offsetMs)` | ✅ |
| Send `BID_PLACE` | client→server with `clientBidId` + `amountCents` | ✅ |
| Animate price flip on `BID_ACCEPTED` | F09 odometer | ✅ |
| "You're leading" flash when self wins | F06 | ✅ |
| "Overtaken" banner when was-self displaced | F07 | ✅ |
| Shake + toast on `BID_REJECTED` | F08 + `bidRejectCopy[code]` | ✅ |
| Light-sweep + extendCount badge on `AUCTION_EXTENDED` | F02 — P5 trust signal | ✅ |
| Leaderboard with TOP-3 halos + FLIP animation | F11 + F12, `GET /leaderboard` | ✅ (manual refresh; auto-fetch on rebroadcast = TODO) |
| AI bubble visible during LIVE (placeholder text) | T7 LLM stream (currently stubbed) | ✅ scaffold only |
| AI bubble offline degrade badge | F19 + P3 — first-class | ✅ |
| Hammer overlay on `AUCTION_SOLD` | F23 — A→B accent flip | ✅ |
| "查看证据卡" CTA from hammer | links to `?view=evidence` | ✅ |
| Static gray finale on `AUCTION_NO_BID` | F29 | ✅ (minimal — could be richer) |
| Red stamp on `AUCTION_CANCELLED` | F30 | ✅ (minimal) |
| Connection bar (reconnecting / sync gap / schema mismatch) | P7 + F28 | ✅ |
| Server-clock drift indicator | F05 | ✅ |
| Pull-to-resync gesture | F26 | ✅ |
| Reconnect with exp backoff + ROOM_JOIN(lastSeq) | useAuctionRoom hook | ✅ |
| `seq` watermark visible | P2 — engineering surface | ✅ (header) |
| Schema version mismatch banner | P7 | ✅ |
| Reduced-motion auto-degrade | P9 | ✅ |
| Long-press bid tier wheel | F25 | ⬜ NOT BUILT |
| Audio cues (heartbeat, gavel, accept-tones) | F14/F15/F16/F17 | ⬜ blocked on §7.2 |
| Mobile haptics on accept/sold | F27 | ⬜ NOT BUILT |
| "上车" join ticker | F22 | ⬜ NOT BUILT |
| 围观人数 ticker | F21 | ⬜ NOT BUILT |
| 黑马 banner (jump-bid) | F13 | ⬜ NOT BUILT |
| 心动值 progress bar | F24 | ⬜ NOT BUILT |
| 福袋 hourly easter egg | F32 | ⬜ NOT BUILT |
| 主播话术弹幕 (AI as bullet text) | F33 (alt to AIBubble) | ⬜ NOT BUILT |
| Champagne/烟花 particles on SOLD | F34 | ⬜ NOT BUILT |
| Hourglass particle countdown | F03 | ⬜ NOT BUILT |
| Background color-temp ramp | F04 | ⬜ NOT BUILT |
| Catchup fast-forward of replayed events | F28 — partial | 🟡 gap-bar exists, event replay animation TODO |
| Combo counter on self-streak | F10 | ⬜ NOT BUILT |

### §3.3 Mobile H5 — Evidence card (P0)

| Capability | Wire dependency | Status |
|---|---|---|
| Fetch evidence card | `GET /api/auctions/:id/evidence` | ✅ |
| Render solemn palette (.surface-solemn) | A+B accent flip | ✅ |
| Show `chainVerified` badge or break flag | from response | ✅ |
| Show chain head (events_hash) | from response | ✅ |
| Show timeline (seq · type · prevHash · eventHash) | from `timeline[]` | ✅ |
| Hash prefix (8 chars) with click-to-expand | HashCell component | ✅ |
| Show order block if present (auth-only) | from response, conditional | ✅ |
| Show `hashBreakAtSeq` red flag with row highlight | from response | ✅ |
| Dim rows after a hash break | UI logic | ✅ |
| "Back to room" affordance | navigation | ✅ |
| Export evidence as PDF | client-side `react-pdf` or similar | ⬜ P1 |
| Share evidence URL | Web Share API | ⬜ P1 |
| Recompute chain client-side (verification challenge) | `subtle.crypto` HMAC-SHA256 | ⬜ P2 |

### §3.4 PC Admin — VLM facts confirmation (P0 hero)

| Capability | Wire dependency | Status |
|---|---|---|
| Upload product images | `POST /api/products` (existing) | ⬜ |
| Submit images for VLM extraction | `POST /api/facts/draft` (mock T1, real T7) | ⬜ |
| Render fact cards: brand / model / condition / defects / key params | from VLM response | ⬜ |
| Per-card seller actions: confirm / edit / delete | client-side state | ⬜ |
| Show "diff" if seller edited a fact (original vs current) | client-side state | ⬜ |
| Show high-risk fields with disclaimer chip | from `highRisk: true` + `highRiskFieldsDisclaimer` | ⬜ |
| Show confidence indicator on each fact (0–1 scale) | from `confidence` | ⬜ |
| Gate "freeze rules → SCHEDULED" until all cards confirmed | client-side validation + `POST /api/auctions/:id/freeze` | ⬜ |
| Trust indicator showing model name / version | from `modelName` | ⬜ |
| Re-run VLM on a single image | TBD endpoint (T7) | ⬜ P1 |

### §3.5 PC Admin — Live console (P0)

| Capability | Wire dependency | Status |
|---|---|---|
| Big-status header (LIVE / SCHEDULED / SOLD / CANCELLED) | from WS as participant | ⬜ |
| Real-time bid ticker (each `BID_ACCEPTED` becomes a row) | WS broadcast | ⬜ |
| Current price + countdown (read-only, same as Room) | reuse Countdown + PriceDisplay | ⬜ |
| AI auctioneer text preview (seller sees what model is saying) | T7 LLM stream | ⬜ |
| Extend count + max extensions | from `extendCount` + rule | ⬜ |
| Last-N rejected bids (with reason codes) | client-side accumulation | ⬜ |
| Connection health row (WS state, lag, last seq) | from useAuctionRoom | ⬜ |
| Danger zone: "Cancel auction" button | calls `POST /api/auctions/:id/cancel` after 2-step confirm | ⬜ |
| Danger zone: "End early" (terminal SOLD with current price) | NOT in current backend; needs new endpoint | ⬜ P1 |
| Mute/unmute for AI text stream | client toggle | ⬜ |
| Optional: embedded H5 viewer preview (mirror buyer view) | iframe to `?demo=1` mode | ⬜ P1 (Elia recommends NOT P0) |

### §3.6 PC Admin — Cancel-with-confirmation flow (P0)

| Capability | Wire dependency | Status |
|---|---|---|
| Two-step modal: trigger + verify | client-side flow | ⬜ |
| Require seller to retype current price as confirmation | client-side validation | ⬜ |
| Show what's at stake (LIVE bidders, current price, time elapsed) | from store | ⬜ |
| Issue `POST /api/auctions/:id/cancel` only after verify | REST call | ⬜ |
| Display server response status + terminal `AUCTION_CANCELLED` confirmation | WS + REST response | ⬜ |
| Graceful failure if `ERR_ALREADY_TERMINAL` (auction hammered first) | from error code | ⬜ |

### §3.7 PC Admin — Auction publish form (P0)

| Capability | Wire dependency | Status |
|---|---|---|
| Product selector (or create-on-fly) | `POST /api/products` | ⬜ |
| Rule DSL form: starting price, min increment, duration, max extensions, cap price | client-side form (react-hook-form + zod) | ⬜ |
| Server-side validation feedback for rule shape | `POST /api/auctions` response | ⬜ |
| Direct transition to "facts confirmation" page after publish | client navigation | ⬜ |
| Form persistence (draft auto-save) | localStorage | ⬜ P1 |

### §3.8 PC Admin — Orders & Products CRUD (P1)

| Capability | Wire dependency | Status |
|---|---|---|
| Product list with create/edit/archive | `POST /api/products` + (list/edit endpoints TBD) | ⬜ |
| Order list (terminal SOLD auctions become orders) | `GET /api/orders` (TBD) | ⬜ |
| Filter by status, date, auction | client-side | ⬜ |
| Export CSV | client-side | ⬜ P2 |

### §3.9 Mini-program — Stub landing (OPEN DECISION C)

| Capability | Wire dependency | Status |
|---|---|---|
| Detect Douyin in-app browser via UA | client-side | ⬜ |
| Show landing: "请在抖音 App 内打开" with deep-link CTA | static | ⬜ |
| Auction preview card (no live updates) | `GET /api/auctions/:id` snapshot | ⬜ |
| Open in Douyin App deep link | URL scheme | ⬜ |

### §3.10 Cross-cutting requirements

| Capability | Where | Status |
|---|---|---|
| Reduced-motion auto-degrade (P9) | `surface-calm` class + `prefers-reduced-motion` | ✅ |
| Frame-budget runtime guardrail | `lib/perf/frameBudget.ts` | ✅ |
| Schema version detection + user-visible mismatch | useAuctionRoom + ConnectionBar | ✅ |
| `seqguard` dedupe + gap detection | `lib/ws/seqguard.ts` | ✅ |
| Reconnect with exponential backoff | useAuctionRoom (250ms → 8s cap) | ✅ |
| Heartbeat PING at 15s | useAuctionRoom | ✅ |
| Anti-slop visual audit (P10) | run `/web-design-guidelines` + `/frontend-design` skills | ⬜ (skills installed, audit TODO) |
| A11y audit (focus management, contrast, semantic HTML) | run `/web-design-guidelines` | ⬜ TODO |
| React perf audit (composition, waterfalls, bundle) | run `/vercel-react-best-practices` + `/vercel-composition-patterns` | ⬜ TODO |
| E2E test (room flow) | webapp-testing skill or Playwright | ⬜ TODO |
| Unit tests on money helpers + seqguard | Vitest | ⬜ TODO |

---

## §4 Backend wire surface — what the frontend talks to

### §4.1 REST endpoints

All endpoints served by `apps/lumen` on `:8080`. Vite proxy at `/api/*` routes through. Auth via JWT in `Authorization: Bearer <token>` or `?token=` query.

| Method · path | Auth | Body / Query | Response | FE usage |
|---|---|---|---|---|
| `POST /api/dev-login` | no | `{ nickname }` | `{ userId, token, nickname }` | Session bootstrap |
| `POST /api/products` | seller | `{ title, description, imageUrls[] }` | `{ productId }` | Admin: create |
| `POST /api/facts/draft` | seller | `{ productId, imageUrls, title, description }` | VLM facts object (§4.5) | Admin: VLM page (proxied to ai-sidecar in T7) |
| `POST /api/auctions` | seller | `{ productId, rules{} }` | `{ auctionId }` | Admin: publish |
| `GET /api/auctions/:id` | any | — | `RoomSnapshot` | Pre-LIVE preview, snapshot fallback |
| `POST /api/auctions/:id/freeze` | owner | — | `{ code }` (`OK_FROZEN` / `ERR_FACTS_NOT_CONFIRMED` / `ERR_BAD_STATE`) | Admin: DRAFT → SCHEDULED |
| `POST /api/auctions/:id/start` | owner | `{ durationMs? }` | `{ code, endAtMs }` | Admin: SCHEDULED → LIVE |
| `POST /api/auctions/:id/cancel` | owner | — | `{ code }` | Admin: → CANCELLED |
| `GET /api/auctions/:id/leaderboard?n=10` | any | `n ∈ [1, 100]` | `{ auctionId, leaderboard: [{ userId, amountCents }] }` | Room: leaderboard component |
| `GET /api/auctions/:id/evidence` | mixed (order block requires auth) | — | `EvidenceCard` (§4.6) | Mobile H5 EvidenceScreen + Admin |
| `GET /api/auctions/:id/events-count` | any | — | `{ count }` | Admin: stats |
| `POST /api/cancel` (Elia's PR #40 adds a one-click admin button) | owner | — | mirror of `/cancel` | Admin: quick cancel |

### §4.2 WebSocket envelope

All envelopes — both directions — use this shape (per `proto/ws-envelope.md`):

```ts
type WsEnvelope<T = unknown> = {
  schemaVersion: number      // currently 1 — bump on breaking change
  type: string               // SCREAMING_SNAKE — see tables below
  auctionId?: string
  requestId?: string
  seq?: number               // monotonic per auction; server-side events carry; ack carries
  serverTimeMs: number       // used by client to derive serverClockOffsetMs
  data: T
}
```

### §4.3 WS — server → client events

| Type | Fields in `data` | Trigger | FE response |
|---|---|---|---|
| `ROOM_SNAPSHOT` | `status, currentPriceCents, winnerId, endAtMs, seq, rules?` | Sent after `ROOM_JOIN` or on gap > 200 reset | Reset seqguard watermark; initialize room state and seller-configured bid rules |
| `BID_ACCEPTED` | `seq, userId, displayName, amountCents, endAtMs, status, serverTimeMs` | After `place_bid.lua` returns `OK_ACCEPTED`/`OK_EXTENDED`/`OK_SOLD` | Animate price flip; update countdown end; if self → F06 flash; if was-self → F07 banner |
| `BID_REJECTED` | `code` (one of: `ERR_NOT_LIVE`, `ERR_AFTER_END`, `ERR_TOO_LOW`, `ERR_AUCTION_PAUSED`, `ERR_NOT_ALLOWED`, `ERR_BAD_INPUT`, `ERR_INTERNAL`, `ERR_RATE_LIMITED`) | `place_bid.lua` rejects | F08 shake + toast with `bidRejectCopy[code]` |
| `AUCTION_EXTENDED` | `seq, endAtMs, extendCount` | `place_bid.lua` triggered anti-snipe | F02 light-sweep on countdown; ExtendBadge increment |
| `AUCTION_SOLD` | `seq, winnerId, amountCents, status: 'SOLD'` | Cap-hit in `place_bid.lua` OR Timer's `close_auction.lua` | A→B accent flip; HammerOverlay; F23 Hall of Fame |
| `AUCTION_NO_BID` | `seq, status: 'NO_BID', serverTimeMs` | Timer's `close_auction.lua` when no accepted bids | F29 static gray-scale end |
| `AUCTION_CANCELLED` | `seq, status: 'CANCELLED', serverTimeMs` | `cancel_auction.lua` | F30 red stamp overlay |
| `PONG` | `{}` | Server response to client PING | Heartbeat ack, ignore |

### §4.4 WS — client → server events

| Type | Fields in `data` | FE source | Backend dispatch |
|---|---|---|---|
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | useAuctionRoom on (re)connect | Gateway joins room; replays from `lastSeq+1` via XRANGE; if gap > 200 → SNAPSHOT |
| `BID_PLACE` | `{ clientBidId, amountCents }` | BidButton.onPlace | Gateway → Bid Engine → `place_bid.lua` |
| `PING` | `{}` | useAuctionRoom interval | Server PONG |

### §4.5 VLM facts response (T1 mock, T7 Doubao)

```ts
type FactsDraft = {
  facts: Array<{
    field: string         // "category" | "brand" | "model" | "condition" | "defects" | ...
    value: string
    confidence: number    // 0..1
    highRisk: boolean     // true → seller-declaration only, not VLM-verifiable
  }>
  highRiskFieldsDisclaimer: string  // CN copy to surface near high-risk fields
  modelName: string                 // "mock-vlm-T1" | "doubao-..." in T7
}
```

### §4.6 Evidence card response

```ts
type EvidenceCard = {
  auctionId: string
  status: AuctionStatus
  currentPriceCents: string
  winnerId: string            // "" if none
  seq: number
  eventsCount: number
  factsConfirmed: boolean
  timeline: Array<{
    seq: number
    eventType: string         // "BID_ACCEPTED" | "AUCTION_SOLD" | ...
    payload: unknown
    eventHash: string         // hex
    prevHash: string          // "" at genesis
  }>
  eventsHash: string          // chain head; "" if empty
  chainVerified: boolean
  hashBreakAtSeq?: number     // present only when chainVerified=false
  order?: {                   // present only when order exists; auth-gated
    id: string
    auctionId: string
    productId: string
    buyerId: string
    amountCents: string
    status: string
    createdAt: string
  }
  note?: string
}
```

### §4.7 Auth + session

```
1. Frontend → POST /api/dev-login { nickname }
2. Backend ← { userId, token, nickname } (JWT signed with JWT_SECRET)
3. Frontend stores token; opens WS with `?token=<jwt>`
4. Frontend includes Authorization: Bearer <jwt> on REST calls requiring auth
```

Until production OTP lands (P1), `ENABLE_DEV_LOGIN=true` mints anonymous tokens.

---

## §5 Wire-level walkthroughs — life of each interaction

These are the canonical interaction shapes any design must support without disrupting.

### §5.1 Life of a bid (happy path)

```
1. User taps BidButton with target price P
2. FE: send WS BID_PLACE { clientBidId: <uuid>, amountCents: P-as-string }
3. Backend Bid Engine: place_bid.lua atomic check
   - State == LIVE ✓
   - Now < endAtMs ✓
   - amount >= currentPrice + minIncrement ✓
   - amount <= capPrice (if set) ✓
   - userId != sellerId ✓
   - clientBidId not in dedupe ✓
   → write state Hash (currentPrice, winnerId, seq+1)
   → optionally compute anti-snipe extension (last 10s + extendCount < maxExtensions)
   → write Stream <seq+1>-0 with BID_ACCEPTED (+ AUCTION_EXTENDED if extended)
   → cache ack into dedupe Hash
   → return structured map to Go dispatcher
4. Backend Gateway:
   - direct WS response to originating socket: BID_ACCEPTED envelope
   - Pub/Sub wakeup hint to all gateways
5. All gateways read Stream XRANGE since last broadcast seq → fan out events
6. FE receives BID_ACCEPTED (twice — direct + broadcast; seqguard dedupes)
7. FE: store reducer → animate price flip (F09), update endAtMs if extended,
   if self → F06 flash, if was-self → F07 banner
8. FE: if was-extended, AUCTION_EXTENDED also arrives; ExtendBadge animates
```

Performance budget: ack p95 < 80ms, broadcast p95 < 150ms (Plan V9 §4 SLOs).

### §5.2 Life of a bid (rejection — too low)

```
1. User taps with P = currentPrice (no increment)
2. FE → BID_PLACE
3. place_bid.lua → returns ERR_TOO_LOW
4. Gateway → BID_REJECTED { code: 'ERR_TOO_LOW' } to originating socket
5. FE: store.lastRejectCode = 'ERR_TOO_LOW'
6. FE: BidButton shakes (F08); toast with bidRejectCopy.ERR_TOO_LOW (CN copy)
```

### §5.3 Life of a hammer (Timer-driven SOLD)

```
1. Timer Worker scans auction:active ZSET every 100ms
2. For each auctionId with score (endAtMs) <= Redis TIME, call close_auction.lua
3. close_auction.lua:
   - Re-check Redis TIME ≥ endAtMs ✓ (or return ERR_NOT_DUE for refresh)
   - If state Hash has bids → write SOLD terminal; UntrackActive
   - Else → write NO_BID terminal; UntrackActive
   - Write Stream <seq+1>-0 with AUCTION_SOLD (or AUCTION_NO_BID)
4. Gateway broadcasts via Stream fan-out
5. FE receives AUCTION_SOLD
6. FE: store reducer → status='SOLD'
7. FE: Room re-renders → isSolemnState() returns true → document.body adds .surface-solemn
8. FE: HammerOverlay becomes visible (status === 'SOLD')
9. FE: 6/10 design moment — gold serif reveal, particles, winner name
10. User taps "查看证据卡 →" → navigation to ?view=evidence
```

### §5.4 Life of a seller cancel

```
1. Seller (admin) clicks "Cancel auction" in live console
2. FE: open 2-step modal — ask seller to retype current price (P)
3. Seller types correct price → modal calls POST /api/auctions/:id/cancel
4. Backend handler:
   - Verify owner ✓
   - If DRAFT → MySQL-only cancel
   - If SCHEDULED/LIVE → cancel_auction.lua atomic terminal write
   - Returns { code: 'OK_CANCELLED' }
5. Stream → AUCTION_CANCELLED broadcast
6. FE in Room (buyers): status='CANCELLED', F30 red stamp
7. FE in Admin console: confirmation toast, return to dashboard
```

### §5.5 Life of a reconnect (transient network blip)

```
1. WS close event fires (transient drop)
2. useAuctionRoom: reconnectAttemptRef increments
3. ConnectionBar shows 'reconnecting…' (orange strip)
4. After exp backoff (250ms → 500 → 1000 → ... cap 8s)
5. New WS opens
6. FE sends ROOM_JOIN { auctionId, lastSeq: <seqguard.watermark> }
7. Gateway reads Stream XRANGE from lastSeq+1
8. If delta <= 200: replay all missed events; backwoods clear sync banner
9. If delta > 200: gateway sends ROOM_SNAPSHOT instead; FE resets seqguard
10. ConnectionBar shows 'syncing N events' briefly then disappears
11. Any missed BID_ACCEPTED/AUCTION_EXTENDED/AUCTION_SOLD applies via reducer
```

### §5.6 Life of a schema mismatch

```
1. Server bumps schemaVersion to 2 (breaking change)
2. Old FE client opens WS, receives envelope with schemaVersion=2
3. FE useAuctionRoom: dispatch connection:schema_mismatch event
4. ConnectionBar shows red strip: "客户端版本与服务器协议不匹配,请刷新"
5. FE does NOT process the envelope's data (incompatible)
6. User refreshes; new bundle has schemaVersion=2; works
```

### §5.7 Life of a VLM facts confirmation (admin)

```
1. Seller uploads product images via PC admin
2. FE: POST /api/products → { productId }
3. FE: POST /api/facts/draft { productId, imageUrls, ... }
4. Backend proxies to ai-sidecar at :8090/facts/draft
5. ai-sidecar returns FactsDraft (T1 mock, T7 real)
6. FE: render fact cards in VLM Facts Page
7. Per fact: seller can edit/confirm/delete
   - Confirmed cards lock to green
   - Edited cards show diff (original strikethrough + new)
   - Deleted cards collapse
8. "Confirm all" button enabled only when 100% of fact cards have action
9. FE: state.factsConfirmed = true → seller publishes auction via POST /api/auctions
10. Backend stores facts snapshot; auction in DRAFT
11. Seller clicks "Freeze rules" → POST /api/auctions/:id/freeze
12. Backend freeze handler:
    - Verify factsConfirmed = true ✓
    - Run freeze_rules.lua → OK_FROZEN
    - status DRAFT → SCHEDULED
13. Seller clicks "Start" → POST /api/auctions/:id/start { durationMs }
14. start_auction.lua → OK_LIVE; endAtMs computed
15. Auction now visible to buyers via /room?auction=<id>
```

### §5.8 Life of an AI auctioneer message (T7 — future)

```
1. Backend (in start_auction.lua / place_bid.lua / Timer / close_auction.lua)
   determines a trigger occurred (open / jump / cold-30s / hammer)
2. Backend dispatches to ai-sidecar with trigger context
3. ai-sidecar calls LLM; streams text back
4. Gateway broadcasts text as WS event (envelope TBD — likely AI_AUCTIONEER_TEXT)
5. FE AIBubble: receives stream; typewriter renders char-by-char
6. Bubble tone reflects trigger (open=blue / jump=orange / cold=gray / hammer=gold)
7. If sidecar offline → backend skips broadcast; FE shows offline badge per P3
```

---

## §6 Feature-to-wire mapping — every #41 §3 feature traced to its backend

For Elia's review locked-MUST set and the tension arc, here's the precise wire dependency. **If a feature doesn't anchor to a backend invariant or an AI/materials goal, it's a candidate for cut.**

### §6.1 MUST features (from #41 review)

| ID | Feature | Backend anchor | Wire signal | FE state |
|---|---|---|---|---|
| F02 | Anti-snipe extend badge + sweep | T2 `place_bid.lua` extension branch | `AUCTION_EXTENDED { extendCount, endAtMs }` | ✅ ExtendBadge |
| F05 | Server-clock drift indicator | Every WS envelope `serverTimeMs` | continuous `clock` reducer | ✅ ClockDriftIndicator |
| F19 | AI offline degrade badge | T1/T7 sidecar absence detectable | absence of AI_* events; HTTP fail on /facts | ✅ AIBubble offline state |
| F20 | VLM facts confirmation (admin) | T1 mock `POST /facts/draft`; T7 real | REST request/response shape | ⬜ NOT BUILT (T5a) |
| F26 | Pull-to-refresh = ROOM_JOIN(lastSeq) | T2 catchup protocol | client→server ROOM_JOIN | ✅ PullToResync |
| F28 | Reconnect catchup fast-forward | T2 Stream XRANGE replay | replay of events with seq | 🟡 banner exists, event replay anim TODO |
| F31 | Evidence hash-chain timeline | T4 `event_hash`/`prev_hash` (PR #34) | `GET /evidence` response | ✅ EvidenceScreen (live when #34 merges) |

### §6.2 Tension arc features (the 30s silent demo)

| Beat | Feature | Wire | FE state |
|---|---|---|---|
| 1 | F01 — final 10s pulse | `endAtMs - now <= 10s` derived | ✅ Countdown CSS animation |
| 2 | F06 — you-leading flash | `BID_ACCEPTED { userId == self }` | ✅ Room overlay |
| 3 | F07 — overtaken banner | `BID_ACCEPTED { userId != self && prevWinner == self }` | ✅ Room banner |
| 4 | F09 — price odometer | `BID_ACCEPTED { amountCents }` change | ✅ PriceDisplay |
| 5 | F12 — leaderboard FLIP | leaderboard refresh + ranking change | ✅ Leaderboard layout animation |
| 6 | F14/F15 — heartbeat → gavel sound | T-10s threshold + `AUCTION_SOLD` | ⬜ blocked on §7.2 audio |
| 7 | F23 — Hall of Fame | `AUCTION_SOLD` | 🟡 v0 (HammerOverlay) |

### §6.3 Nice / cut candidates

If a feature is unanchored, it loses to the MUST list:

| ID | Feature | Has backend anchor? | Recommendation |
|---|---|---|---|
| F03 sand hourglass | only `endAtMs` | Optional aesthetic; consider for solemn palette only |
| F04 background color-temp | only `endAtMs` | Cheap if CSS-only; skip if competes with F01 pulse |
| F10 combo counter | self-bid streak (client-derived) | Skip — Douyin pattern but no engineering value |
| F13 黑马 banner | jump in `amountCents` (client-derived from rule) | P1 only — fun but not anchoring |
| F21 viewer count | requires backend presence count (NOT IMPLEMENTED) | Skip unless presence channel lands |
| F22 上车 ticker | requires join broadcast (NOT IMPLEMENTED) | Skip |
| F24 心动值 | client-derived from total bid count | Skip — pure decoration |
| F25 long-press tier wheel | client-only | P1 — improves UX, no engineering signal |
| F27 haptics | client-only Web Vibration API | P1 — easy and on-brand |
| F32–F34 (福袋/弹幕/礼物) | none — pure aesthetic | Reject — risks Douyin-slop |

---

## §7 Frontend data layer

### §7.1 Zustand store shape (existing `src/state/store.ts`)

```ts
type RoomState = {
  // wire-derived
  status: AuctionStatus          // canonical 7 states
  currentPriceCents: string      // P1
  winnerId: string | null
  winnerDisplayName: string | null
  endAtMs: number | null
  seq: number
  extendCount: number
  serverClockOffsetMs: number    // P4

  // connection
  connection: ConnectionStatus
  schemaMismatch?: { got: number; want: number }
  recentSyncGap: number

  // ephemeral feedback
  lastRejectCode: BidRejectCode | null
  bidFlash: { kind: 'leading' | 'overtaken'; ... } | null

  // derived / fetched
  leaders: Leader[]              // from REST /leaderboard

  // reducer
  dispatch: (e: RoomEvent) => void
  setLeaders: (xs: Leader[]) => void
}
```

The reducer is a single switch over `RoomEvent` kinds; every WS event becomes a `RoomEvent` via `useAuctionRoom`'s message handler. **No business logic lives in components**; they read derived state via Zustand selectors.

### §7.2 Seqguard (`src/lib/ws/seqguard.ts`)

```ts
class SeqGuard {
  accept(seq?: number) → { apply: boolean; gap: number }
  reset(seq: number)
}
```

Two functions:
1. Drop duplicates (originating socket gets ack + broadcast — seqguard returns `apply: false` for the second)
2. Detect gaps (server gap from missed broadcast — caller may surface via UI)

Reset on `ROOM_SNAPSHOT`.

### §7.3 Performance guardrail (`src/lib/perf/frameBudget.ts`)

rAF-based rolling mean; flips `body.surface-calm` when sustained >22ms frames (~45fps); recovers under <17ms. CSS `.surface-calm` removes decorative animations. Honors `prefers-reduced-motion` (no-op if user pref set).

### §7.4 Money helpers (`src/lib/money.ts`)

- `formatCentsCNY(cents: string): string` — `"¥1,234.56"`
- `cmpCents(a: string, b: string): -1 | 0 | 1` — string compare without parsing
- `addCents(a: string, b: string): string` — BigInt-based add

All boundary code goes through these. **No code path may use `parseInt` / `Number` on a money string.**

### §7.5 Evidence cache (planned)

Evidence fetch is currently one-shot. For T4 production, cache by `auctionId` with a `chainVerified` invalidation key. If client wants the recompute challenge (P2), expose `verifyChain(evidence): {ok, breakAt}` using `subtle.crypto` HMAC-SHA256.

---

## §8 Performance budget — the SLOs the frontend cannot break

| Budget | Threshold | Where enforced |
|---|---|---|
| WS message handler | ≤5ms per message | useAuctionRoom dispatches Zustand reducer only; no React reconciliation in handler |
| Continuous animation frame | ≤16ms (60fps); ≤22ms triggers `surface-calm` | CSS `transform`/`opacity` only; runs on compositor |
| `prefers-reduced-motion` honor | always | Tailwind v4 reduced-motion media query global |
| First-contentful-paint (mobile H5) | <1.5s on mid-tier mobile | Vite build; tree-shake; route-level split if bundle grows |
| Time-to-interactive (mobile H5) | <2.5s | No third-party JS during boot; WS opens after first paint |
| Production bundle (gzipped JS) | <150KB target | Currently 107KB |
| Reconnect-to-room-resync | <1s for ≤200 events | Backend XRANGE replay; FE applies in single tick |
| WS broadcast end-to-end | p95 <150ms (backend SLO) | FE must not block: no synchronous DOM work in WS handler |
| Ack | p95 <80ms (backend SLO) | Same — FE handler stays cheap |

If a design proposal pushes any of these, redesign.

---

## §9 Demo storyline — what must work end-to-end

The 3-minute demo (T10) requires this exact path. Every visible screen must support it.

```
00:00–00:30 — Seller flow (PC admin)
  • Seller uploads product → VLM facts page shows draft
  • Seller confirms 5 facts → publish → freeze → start LIVE
  • Auction visible at /room?auction=<id>

00:30–00:45 — Buyer enters room (Mobile H5)
  • Room loads → ROOM_SNAPSHOT → status: LIVE, countdown 60s, price ¥0
  • Show AIBubble with auctioneer open-line
  • Show ClockDriftIndicator (Δ visible to highlight P4)

00:45–02:00 — Multi-bidder concurrent bidding
  • Bot1, Bot2, Bot3 (or live judges) place bids
  • Each BID_ACCEPTED: price odometer + leaderboard FLIP
  • In final 10s: F01 pulse activates → bid lands → F02 anti-snipe extension (+30s)
  • Show extendCount badge growing
  • Show seq # in header counting monotonically

02:00–02:30 — Hammer + evidence
  • Timer expires → close_auction.lua → AUCTION_SOLD
  • HammerOverlay: A→B accent flip → gold serif winner reveal
  • Tap "查看证据卡 →" → EvidenceScreen
  • Show hash-chain timeline → chain head → chainVerified badge

02:30–03:00 — Backend invariants on screen (judges' eyes)
  • Highlight reconnect: kill WS in console → ConnectionBar → ROOM_JOIN(lastSeq) → catchup banner
  • Highlight clock drift: simulate offset → Δ shows
  • Highlight reduced-motion: enable OS pref → animations calm
  • Replay Verifier (T6 — future): show three-way consistent output
```

If the design doesn't support this flow visibly, reject.

---

## §10 Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| T4 #34 doesn't merge before freeze | Med | FE forward-compatible with stub; timeline empty until merge |
| T5 multi-gateway #38 doesn't ship | Med | FE works with single gateway; performance test deferred |
| T7 AI sidecar full doesn't ship | Med | Mock VLM endpoint covers F20 page; AIBubble shows placeholder; offline badge always works |
| Audio (§7.2) not resolved | Low | F14–F17 deferred; doesn't block demo |
| §7.1 Mini-program scope creeps | Low | C decision (stub) locked; reject any feature ask for native |
| Frontend bundle grows past 150KB | Low | Route-level code splitting (EvidenceScreen, admin) |
| Schema bump mid-freeze | High | Negotiate schemaVersion change with all-member sign-off; ConnectionBar surfaces mismatch |
| Backend p95 SLOs miss | High | FE has nothing to do here; surface metrics via Grafana (T8); demo highlights green dashboard |
| Auction can't be cancelled mid-LIVE in time for demo | Low | Cancel-with-confirmation flow is P0 — must ship in FE-T5a |
| Verifier hash-chain ratification not done by all-members | Med | T4 ratify gate (#34 description) — design assumes chain landed |

---

## §11 Open questions / blockers

| # | Question | Who owns | Blocks |
|---|---|---|---|
| Q1 | Mini-program scope (#41 §7.1) | All-member vote | Mini-stub page design |
| Q2 | Sound default (#41 §7.2) | Product/legal | F14–F17 audio features |
| Q3 | Animation frame budget mode (#41 §7.3) | FE owner | P9 implementation (DONE — option B locked) |
| Q4 | PC ↔ H5 design language (#41 §7.4) | Design vote | T5a admin token system |
| Q5 | AI offline copy (#41 §7.5) | Copy review | DONE — "拍卖师暂离 · 出价不受影响" locked |
| Q6 | Reserve price (V9 §2 OPEN DECISION) | All-member vote (contract PR) | P1 only — not blocking P0 |
| Q7 | One-T-per-PR vs bundled trunk flush (issue #36) | Process RFC | Future PR strategy |
| Q8 | Repo structure ratification (issue #14) | All-member ratify | Onboarding doc clarity |
| Q9 | T3 follow-up: handleCancel TOCTOU (issue #32 P1) | Eliaaazzz | Edge-case correctness (T3 done; demo unlikely to hit) |
| Q10 | Issue #41 vote convergence by 2026-05-27 EOD | All-member | T5a/T6.2/T7 feature lock |

---

## §12 Cross-check rubric for design proposals

When evaluating a design proposal (e.g. from `/frontend-design` or a human designer):

### §12.1 Hard rejection criteria (any one fails → redesign)

- [ ] Money rendered as Number anywhere
- [ ] Countdown uses `Date.now()` directly (no server skew)
- [ ] State labels don't map to canonical 7 (e.g. "Hammered", "Extended" as states, "Cooling")
- [ ] `extendCount` is hidden when >0
- [ ] AI bubble has no offline state
- [ ] No visible reconnect / catchup UI
- [ ] Evidence card uses illustration over hash text
- [ ] Decorative gradient/glow with no event anchor
- [ ] Hammer moment doesn't flip to solemn palette
- [ ] 60fps animation driven by React state

### §12.2 Soft rejection criteria (multiple fails → redesign)

- [ ] Numeric column without `tabular-nums`
- [ ] Cliched livestream commerce patterns (转盘, lucky-draw)
- [ ] Generic AI-default fonts (Inter, Roboto, Arial as display)
- [ ] No safe-area-inset on iPhone notch / home indicator
- [ ] CTA outside thumb-reach on mobile
- [ ] No `prefers-reduced-motion` consideration
- [ ] AI bubble dominates screen when LIVE
- [ ] Leaderboard takes more visual weight than price/countdown
- [ ] No clear demo-screen-1 hero (final 10s)

### §12.3 Must-cover screens

The proposal must cover all six anchor screens from `design-system.md` §14.1:

1. Mobile H5 — Room (LIVE, 30s remaining)
2. Mobile H5 — Room (final 10s)
3. Mobile H5 — Hammer overlay (SOLD)
4. Mobile H5 — Evidence card
5. PC Admin — VLM facts confirmation
6. PC Admin — Live console

### §12.4 Wire integrity checks

For each screen, the proposal must:
- Identify which wire events drive each visible state
- Identify which backend invariants are surfaced
- Not contradict the §4 contract (event names, field names, money-as-string)
- Show empty/loading/error states for the data sources

---

## §13 What we ask of designs vs what we build ourselves

| Decision | Owned by design | Owned by engineering |
|---|---|---|
| Color tokens (palette) | Confirm A+B accent treatment | Add to `tokens.ts` + Tailwind theme |
| Typography stack | Pick distinct fonts within design-system.md constraints | Add to `tokens.ts` `--font-*` |
| Motion timing curves | Recommend specific spring/curve values | Add to `tokens.ts` motion + use in components |
| Layout (spacing, density, alignment) | Per-screen high-fidelity mock | Implement via Tailwind utilities |
| Iconography | Suggest semantic icons + style | Source SVGs / use Phosphor/Lucide |
| Copy (CN text) | Recommend semantic copy per screen | Place in component + i18n-ready strings |
| Tech stack | — | Locked: Vite + React 19 + TS + Tailwind v4 + Zustand + Framer Motion |
| WebSocket contract | — | Locked per `proto/ws-envelope.md` |
| State machine labels | Map labels to canonical 7 | Use in `StatusBadge` |
| Hammer moment palette flip | Confirm specific solemn palette specifics | Code: `isSolemnState()` predicate in tokens.ts |
| A11y patterns | Specify focus rings, aria, color contrast | Implement via primitives |

If a design proposal makes engineering decisions (e.g. "let's use Socket.IO" or "use floats for money"), reject the relevant part.

---

## §14 References

### §14.1 Backend contracts (under repo `proto/`)

| Doc | What's in it |
|---|---|
| `proto/openapi.yaml` | REST API surface |
| `proto/ws-envelope.md` | WS envelope shape + all event types + countdown formula |
| `proto/error-codes.md` | Lua-internal → wire code mapping; copy keys for `bidRejectCopy` |
| `proto/evidence-card.md` | Evidence response schema + HMAC-SHA256 hash chain |
| `proto/ai-events.md` | VLM facts + LLM auctioneer 4 triggers (T7) |
| `proto/redis-keys.md` | Redis hot-key conventions |
| `proto/db-schema.md` | MySQL table layout |
| `proto/security-baseline.md` | SSRF allowlist, prompt-injection mitigations |

### §14.2 Planning issues

| # | Title | Why FE cares |
|---|---|---|
| #1 | Plan V9 (trunk-driven) | Canonical T0–T10 ladder |
| #2 | Architecture RFC v2 | 9 engineering boundaries |
| #11 | Onboarding | Elevator pitch + rubric weights |
| #14 | Scaffolding RFC | `apps/web/` location + monorepo shape |
| #15 | Workflow v2 (CLOSED) | Dev-log / review discipline |
| #36 | One-T-per-PR vs bundled flush | Future PR cadence |

### §14.3 Design issues (this thread)

| # | Title | Status |
|---|---|---|
| #41 | Parent design brainstorm + evaluation framework | Awaiting all-member vote by 2026-05-27 EOD |
| #42 | PC admin sub-issue | Awaiting parent |
| #43 | Mobile H5 sub-issue | Awaiting parent |

### §14.4 In-flight PRs (verify before integrating)

| PR | What's in it | FE consumes |
|---|---|---|
| #34 | T4 persistence hash chain + idempotent order + evidence card v0 | `GET /evidence` shape (already coded against this) |
| #38 | T5 backpressure channel split + multi-gateway fanout | Multi-gateway resilience (no FE change needed; same protocol) |
| #40 | (MERGED) web fixes for static demo HTML | None directly — `apps/web/` is independent of static `web/*.html` |
| #24 | T9 chaos-runner skeleton | Useful for future chaos drills; demo storyline §9 references |
| #18 | Observability scaffold (prometheus + grafana) | T8 dashboard for demo |

### §14.5 Current FE codebase (`lumen-frontend/`)

The design pass (2026-05-26) is now the canonical frontend codebase.
Stack: React 18 + Vite 5 + Zustand v4 + react-router-dom v6, plain
JavaScript (JSX), CSS custom properties in `src/styles.css`. No
Tailwind, no animation library — every motion is a hand-rolled CSS
`@keyframes` running on compositor-friendly properties (P8).

```
lumen-frontend/
├── docs/
│   ├── design-system.md         ← design brief (visual / principles / tokens)
│   └── project-blueprint.md     ← (this file — engineering spec)
├── index.html
├── vite.config.js               ← /api + /ws proxy → VITE_API_BASE / VITE_WS_BASE
├── .env.example
├── package.json
└── src/
    ├── main.jsx · App.jsx       ← React + BrowserRouter root + 22-route table
    ├── styles.css               ← Design tokens (§6) + ~30 CSS animations
    ├── lib/
    │   ├── auth.js              ← ensureSession() → dev-login JWT cached in localStorage
    │   ├── api.js               ← REST client (/api/*) with bearer auth
    │   ├── ws.js                ← RoomClient: envelope · seqguard · schema check · reconnect · clock skew
    │   ├── types.js             ← AuctionStatus, EventType, BidErrorCode, bidRejectCopy, ConnStatus
    │   ├── clock.js             ← setClockOffset() / serverNow() / msRemaining()
    │   └── format.js            ← formatCentsCNY / addCentsStr / fmtRemaining (all BigInt)
    ├── store/
    │   └── auction.js           ← Zustand: applyEvent reducer over every WS envelope
    ├── routes/
    │   ├── IndexPage.jsx        ← Dev landing — links to every screen (mock + wired)
    │   └── LiveRoomRoute.jsx    ← Real backend-wired Room (canonical wiring example)
    └── components/
        ├── MobileFrame.jsx · DesktopShell.jsx
        ├── primitives.jsx       ← 12+ primitives (Price · Countdown · StatusBadge · Leaderboard · BidButton · AIBubble · ConnectionBar · …)
        ├── atmosphere.jsx       ← LeadingToast · OvertakenSlam · SandHourglass · PulseWaves · BlackHorseBanner · HammerTransition · …
        ├── mobile.jsx           ← <MobileRoom> · <MobileHammer> · <MobileEvidence>
        ├── admin.jsx            ← <AdminVLMFacts> · <AdminConsole>
        ├── adminExtra.jsx       ← <AdminPublish> · <AdminOrders> · <AdminCancelModal>
        └── misc.jsx             ← <MiniProgramStub> · <ConnReconnecting/Syncing/Schema>
```

**What changed from the original lumen-web prototype** (2026-05-25):
- Codebase migrated to the design-pass repo above. lumen-web is retired.
- Wire layer rewritten (`lib/ws.js`, `lib/api.js`, `lib/types.js`,
  `store/auction.js`, `routes/LiveRoomRoute.jsx`) to match the
  backend's actual envelope shape (`type` not `kind`, SCREAMING_SNAKE,
  `endAtMs` not `endTs`, `clientBidId` not `requestId`, REST path
  `/api/` not `/api/v1/`, JWT bearer not cookies).
- Bridge palette added between A and B for the hammer crossfade
  transition (`--bridge-plum-1/2`, `--bridge-rose-gold`,
  `--bridge-twilight`). See `design-system.md` §5.4.
- All 13 screens from the design pass are present as static visual
  mocks; LiveRoomRoute is the only one fully wired today. Other routes
  have stub data marked `DEMO_*` at the top of each component file —
  replace those with `api.*` calls per FE-T6/T4/T5a/T5b/T7 in §2.1.

---

## §15 Closing — the design's job in one paragraph

The judges are 50% engineering. The product's claim is: **every bid is atomically adjudicated, every event is sequence-guaranteed, every auction has a provable hash chain, every reconnect catches up, every clock is server-corrected, every anti-snipe extension is visible, every AI failure is degraded.** The design's job is to make all of that *legible* in 30 seconds of silent video — without becoming an engineering dashboard, without losing the Douyin live-commerce energy, without sliding into抽奖 aesthetics, and without violating any of the §4 wire contracts. We use A+B accent to honor both halves: Douyin during the action (D5), AuctionHouse at the hammer (D4, D9). Everything in this document is a constraint that supports that single goal.
