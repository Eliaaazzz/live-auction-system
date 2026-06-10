# Lumen Auction · Front-End

React + Vite front-end for the Lumen Auction live-bidding system. Pairs with
the [`live-auction-system`](https://github.com/Eliaaazzz/live-auction-system) Go
backend via REST (`/api/*`) and WebSocket (`/ws?auction=…&token=…`).

Design pass dropped 2026-05-26 (13 screens); wire layer aligned to the
backend's `proto/ws-envelope.md` + `proto/error-codes.md` + `proto/evidence-card.md`
on the same day. See `docs/project-blueprint.md` §2.1 for current FE-T status
and `docs/design-system.md` §5–§6 for tokens.

---

## Run

```bash
# 1. Install
npm install

# 2. Configure (or skip — mock data renders out of the box)
cp .env.example .env.local
# edit .env.local — VITE_API_BASE / VITE_WS_BASE point at the backend
# (defaults: http://localhost:8080 / ws://localhost:8080)

# 3. Dev server
npm run dev                 # → http://localhost:5173

# 4. Production build
npm run build && npm run preview
```

`VITE_USE_MOCK_DATA=true` (the default) renders every screen from inline demo
data without touching the backend. Set to `false` to use the real `api.*` and
`RoomClient` against `localhost:8080`.

---

## Routes

| Path | What |
|---|---|
| `/` | Dev index — every screen linked |
| `/room/:auctionId` | **Real** WS-wired buyer room — `LiveRoomRoute` |
| `/preview/room` · `…/final10` · `…/leading` | Mock buyer rooms (no backend) |
| `/preview/hammer` · `…/evidence` · `…/evidence/broken` | Mock terminal screens |
| `/preview/mp` | Mini-program landing stub |
| `/preview/conn/{reconnect,sync,schema}` | WS connection states (forced) |
| `/admin/auctions` | Orders / products list |
| `/admin/auctions/new` | Publish form |
| `/admin/auctions/:id/vlm` | VLM facts confirmation |
| `/admin/auctions/:id/live` | Live console |
| `/admin/auctions/:id/cancel` | Live console + 2-step cancel modal |

---

## Wire-up · backend contract

### Envelope (both directions) · `src/lib/ws.js`

The Lumen backend uses a single envelope shape for every WebSocket frame —
client AND server. `type` is SCREAMING_SNAKE; there is **no separate `kind`
discriminator**.

```jsonc
{
  "schemaVersion": 1,
  "type": "BID_ACCEPTED",          // SCREAMING_SNAKE
  "auctionId": "auc_…",
  "requestId": "…",                // optional, echoed
  "seq": 14922,                    // monotonic per auction
  "serverTimeMs": 1716700000000,   // drives client clock offset on EVERY envelope
  "data": { /* type-specific */ }
}
```

**Client → server** (see `proto/ws-envelope.md` §3.3):

```jsonc
{ "type": "ROOM_JOIN", "data": { "auctionId": "...", "lastSeq": 14921 } }
{ "type": "BID_PLACE", "data": { "clientBidId": "…", "amountCents": "13000000" } }
{ "type": "PING",      "data": {} }
```

**Server → client** (see `proto/ws-envelope.md` §3.2):

| `type` | `data` payload |
|---|---|
| `ROOM_SNAPSHOT`     | `{ status, currentPriceCents, winnerId, endAtMs, seq, rules? }` |
| `BID_ACCEPTED`      | `{ seq, userId, displayName, amountCents, endAtMs, status, serverTimeMs }` |
| `BID_REJECTED`      | `{ code }` (see `bidRejectCopy` in `src/lib/types.js`) |
| `AUCTION_EXTENDED`  | `{ seq, endAtMs, extendCount }` |
| `AUCTION_SOLD`      | `{ seq, winnerId, amountCents, status: 'SOLD' }` |
| `AUCTION_NO_BID`    | `{ seq, status, serverTimeMs }` |
| `AUCTION_CANCELLED` | `{ seq, status, serverTimeMs }` |
| `PONG`              | `{}` |

Schema mismatch is detected client-side from `envelope.schemaVersion`; the
WS hook closes the socket and routes to `<ConnSchema>`.

### REST endpoints · `src/lib/api.js`

Backend exposes routes under `/api/` (NOT `/api/v1/`). Vite proxies in
`vite.config.js`.

```js
api.draftFacts({ productId, imageUrls, title, description })
                                                  // POST /api/facts/draft
api.createProduct(payload)                        // POST /api/products
api.createDraft(payload)                          // POST /api/auctions
api.getAuction(id)                                // GET  /api/auctions/:id
api.freeze(id)                                    // POST /api/auctions/:id/freeze   (DRAFT→SCHEDULED)
api.startLive(id, { durationMs })                 // POST /api/auctions/:id/start    (SCHEDULED→LIVE)
api.cancel(id, payload)                           // POST /api/auctions/:id/cancel
api.getLeaderboard(id, n)                         // GET  /api/auctions/:id/leaderboard?n=10
api.getEvidence(id)                               // GET  /api/auctions/:id/evidence
api.getEventsCount(id)                            // GET  /api/auctions/:id/events-count
api.listAuctions({ status })                      // GET  /api/auctions?status=…    (P1, mock-only today)
```

### Session / Auth · `src/lib/auth.js`

Backend mints JWTs via `POST /api/login { nickname }`, with `POST /api/dev-login`
as a compatibility fallback. Client caches the
token in `localStorage` and attaches it as:

- `Authorization: Bearer <jwt>` on REST calls
- `?token=<jwt>` on the WebSocket URL

```js
import { ensureSession, currentToken, currentUser } from './lib/auth';
await ensureSession('demo');  // one-time at app boot
```

Production OTP / Doubao auth is P1 (post-MVP); replace `auth.js` then.

### Critical invariants — keep these or things WILL break

* **Money is string-cents.** Never `parseFloat`. All add/compare via `BigInt`. (`src/lib/format.js`)
* **Time is server-corrected.** Countdown reads `msRemaining(endAtMs)` from `src/lib/clock.js`; `endAtMs` is server ms-since-epoch; `setClockOffset()` runs on EVERY envelope's `serverTimeMs`. (Blueprint §4 P4 / F05.)
* **Silent reconnect is forbidden.** Always surface `connStatus` to the UI. `<ConnectionBar>` + `<ConnReconnecting/Syncing/Schema>` cover all three states. (Blueprint §4 P7.)
* **`seq` is monotonic per room.** `applyEvent` dedupes by `seq`; resync after reconnect with `ROOM_JOIN { lastSeq }` (backend XRANGE replays delta; >200 → snapshot fallback). (Blueprint §5.4.)
* **Bid rejection copy comes from `bidRejectCopy[code]`.** Add new codes there as the backend grows — don't hard-code strings in components. (`src/lib/types.js`)
* **Hammer is `AUCTION_SOLD`**, not a separate "hammer" message. Frontend reads `type === 'AUCTION_SOLD'` and triggers the A→B bridge crossfade + writes the hash-chain head. (Blueprint §5.6.)
* **VLM facts confirmation gates `SCHEDULED → LIVE`.** Today, seller edits are kept client-side and persisted on `api.freeze(id)`, which atomically snapshots the confirmed facts as part of the DRAFT→SCHEDULED transition. (PATCH per-fact + GET draft will land with T7 if needed.)

---

## Design system

See `docs/design-system.md` for the canonical tokens, principles (P1–P10),
and the A+B accent rule (§5). Short version:

* **Palette A · Douyin-Native** — `--douyin-ink/red/cyan` (mobile room, ticker, hero CTAs)
* **Bridge palette (new, §5.4)** — `--bridge-plum-1/2`, `--bridge-rose-gold`, `--bridge-twilight` (used ONLY during the ~1.05s hammer crossfade; never as default surface)
* **Palette B · AuctionHouse Premium** — `--solemn-deep/gold/cream` (hammer reveal, evidence card, terminal credibility)
* **Type** — `PingFang SC` / `HarmonyOS Sans SC` body · `Noto Serif SC` display · `JetBrains Mono` numerics

All tokens live in `src/styles.css` on `:root`. Animations use compositor-only
properties (`transform` / `opacity` / `box-shadow`) per the blueprint perf
budget; `.surface-calm` (frame-budget auto-degrade) and
`prefers-reduced-motion` reduce all decorative animations to `none`.

---

## Engineering reference

| Doc | Purpose |
|---|---|
| [`docs/design-system.md`](docs/design-system.md) | Design brief — visual direction, A+B+bridge accent rule, design tokens, motion language, anti-slop checklist, exploration ask |
| [`docs/project-blueprint.md`](docs/project-blueprint.md) | Engineering spec — full project topology (9 boundaries), T0–T10 status, frontend functional scope by surface, every WS event + REST endpoint, life-of walkthroughs, demo storyline, risk register |

---

## Notes for the next developer

1. Most demo data lives **inline at the top of each component file**.
   Replace with `api.*` calls — search for `DEMO_LEADERS`, `EVIDENCE_EVENTS`,
   `VLM_FACTS`, `ORDER_ROWS`, `CONSOLE_BIDS`.
2. **AI auctioneer text** uses `<TypewriterText>` for the streaming
   char-by-char effect. Drop in your LLM stream by re-rendering the bubble
   each chunk with the latest accumulated string. T7 (backend) defines the
   wire channel; until it lands, the AIBubble is decorative.
3. The **`<LongPressBidWheel>`** (radial bid tier picker) is wired as a
   prop but no gesture handler yet. Bind to `pointerdown` + 400ms timer on
   the `<BidButton>`.
4. **Admin VLM facts** is the publish gate — backend's `POST /freeze`
   refuses with `ERR_FACTS_NOT_CONFIRMED` until seller has confirmed all 5
   facts. The UI should disable "全部确认后开拍 →" until `confirmedN === total`
   and then call `api.freeze()` followed by `api.startLive()`.
5. **`LiveRoomRoute` is the canonical wiring example.** Mirror its
   ensure-session → REST snapshot → optional REST refresh → open WS pattern
   for any new route that needs live data.

Happy bidding 🔨
