# Integration notes — design pass → backend wiring

**Date**: 2026-05-26
**Author**: Frontend wiring pass on top of the 2026-05-26 design drop.

This document is a punch list of the changes made to the design pass so it
talks to the actual Lumen backend. Hand to reviewers alongside the original
design files for a fast diff.

---

## §1 What changed and why

The original design author wrote a forward-looking wire layer assuming an
`/api/v1/*` REST surface and a `{ kind: ... }`-discriminated WebSocket
envelope. The actual backend ships:

- REST under `/api/*` (no `/v1/`)
- A single envelope shape `{ schemaVersion, type, data, serverTimeMs, ... }`
  with `type` in SCREAMING_SNAKE (per `proto/ws-envelope.md`)
- JWT bearer auth via `POST /api/login` (compatibility fallback: `POST /api/dev-login`)
- Slightly different field names (`endAtMs` not `endTs`, `clientBidId` not
  `requestId`, `winnerId` string not `winner` object)

Five files were rewritten plus one added. **No design / component changes**
were made — every screen renders identically; only the data layer differs.

| File | Action | One-liner |
|---|---|---|
| `src/lib/types.js` | rewrote | Envelope constants + `ClientFrameType` (SCREAMING_SNAKE); split EventType into wire-broadcast vs evidence-only |
| `src/lib/ws.js` | rewrote | `RoomClient` now speaks the real envelope; derives clock offset from every `serverTimeMs`; schema check is client-side |
| `src/lib/api.js` | rewrote | `/api/*` base; bearer auth from `currentToken()`; mapped design's `schedule`/`getVlmDraft`/`verifyChain` to actual backend endpoints (or noted N/A) |
| `src/lib/auth.js` | **NEW** | `ensureSession()` → `POST /api/login` (fallback `POST /api/dev-login`) → localStorage-cached `{ userId, token, nickname }` |
| `src/store/auction.js` | rewrote | Field renames (`endTs`→`endAtMs`); leaders maintained client-side (backend doesn't ship `data.leaders` on BID_ACCEPTED); BigInt-safe jump-bid detection |
| `src/routes/LiveRoomRoute.jsx` | rewrote | Boot order: ensureSession → snapshot → leaderboard seed → ROOM_JOIN WS; `buildRoomUrl()` for canonical `ws://host/ws?auction=…&token=…` |
| `src/components/mobile.jsx` | fix | Removed duplicate `padding` key in inline style (esbuild warning) |
| `src/components/adminExtra.jsx` | fix | Removed duplicate `border` key in inline style |

No `package.json` changes were needed.

---

## §2 Exact wire-protocol deltas

For maintainers diffing against the design's original `ws.js` / `api.js`:

| Design assumed | Real backend | Where fixed |
|---|---|---|
| `{ kind: 'event', type, data }` outer envelope | `{ schemaVersion, type, data, serverTimeMs, ... }` single-discriminator envelope | `lib/ws.js` (entire `onmessage` switch) |
| Client kinds `room.join`, `bid.place`, `heartbeat` lowercase | `ROOM_JOIN`, `BID_PLACE`, `PING` SCREAMING_SNAKE | `lib/types.js` `ClientFrameType` |
| WS URL `/ws/v1/room/:auctionId` | `/ws?auction=…&token=…` | `lib/ws.js` `buildRoomUrl()` |
| `{ kind: 'schema_mismatch', server, client }` server frame | Client-side detection from `env.schemaVersion !== CURRENT_SCHEMA_VERSION` | `lib/ws.js` schema gate |
| `data.endTs` | `data.endAtMs` | `store/auction.js` reducer |
| `data.serverTs` inside event data | `envelope.serverTimeMs` at envelope level | `lib/ws.js` + `store/auction.js` clock hook |
| BID_ACCEPTED `data.winner: {}` | `data.userId` + `data.displayName` flat | `store/auction.js` |
| BID_PLACE `{ amountCents, requestId, ts }` | `{ clientBidId, amountCents }` | `lib/ws.js` `placeBid()` |
| BID_ACCEPTED `data.leaders[]` shipped from server | Not shipped — client maintains via `mergeLeader()` helper from BID_ACCEPTED stream | `store/auction.js` |
| `Date.now()` heartbeat for clock offset | Every envelope's `serverTimeMs` (more frequent calibration) | `lib/ws.js` per-message hook |
| REST base `/api/v1/` | `/api/` | `lib/api.js` |
| `credentials: 'include'` cookie auth | `Authorization: Bearer <jwt>` from `POST /api/login` (fallback `POST /api/dev-login`) | `lib/auth.js` + `lib/api.js` |
| `api.schedule(id, when)` future-dated start | Not in backend — seller publishes, freezes, starts manually | Removed; doc note added |
| `api.getVlmDraft(auctionId)` GET | `POST /api/facts/draft { productId, imageUrls, title, description }` returns one-shot draft | `lib/api.js` `draftFacts()` |
| `api.confirmFact(auctionId, factId, edited)` PATCH per fact | Not in backend; seller edits kept client-side, persisted atomically on `api.freeze(id)` | `lib/api.js` doc note |
| `api.verifyChain(auctionId)` POST | Not exposed as REST today (CLI `make verify-evidence` only); use `chainVerified` boolean from `api.getEvidence()` | `lib/api.js` doc note |
| `api.me()` GET | Not in backend; use `currentUser()` from `lib/auth.js` (cached from login response) | `lib/auth.js` |

---

## §3 Verification

```bash
npm install
npm run build      # → 292.99 kB / 85.88 kB gzip · no warnings
npm run dev        # → http://localhost:5173 — try /, /preview/room, /room/auc_demo
```

The Room route at `/room/:auctionId` does the full backend handshake when
`VITE_USE_MOCK_DATA=false` is set in `.env.local`. All other routes still
render from inline `DEMO_*` mock data.

---

## §4 What's still TODO (wire-up work, not design)

The design is complete. What's left is connecting individual routes to
their backend endpoints. See `project-blueprint.md` §2.1 for the
canonical list. Highest-value items:

| Item | Effort | Blocked by |
|---|---|---|
| `AdminPublish` → `api.createDraft()` on submit | S | none |
| `AdminVLMFacts` → `api.draftFacts()` on mount + `api.freeze()` on confirm | M | none (T1 mock backend works) |
| `AdminConsole` → subscribe `RoomClient` as observer | M | none |
| `AdminCancelModal` → `api.cancel()` after price-verify | S | none |
| `MobileEvidence` → `api.getEvidence()` on route mount | S | UI is forward-compatible; timeline populates on PR #34 merge |
| `AdminOrders` → `api.listAuctions()` | S | backend doesn't ship list endpoint yet (P1) |
| AI auctioneer streaming into `<AIBubble>` | M | T7 backend |

All TODOs are ~10–30 lines of wiring each, following the
`LiveRoomRoute.jsx` pattern.
