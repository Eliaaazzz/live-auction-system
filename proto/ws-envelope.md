# WS Envelope Contract

Materialized from PR #13 `docs/ws-protocol.md`. Encoding: **JSON-only** in T1 (msgpack is Stretch). `type` is **SCREAMING_SNAKE**; envelope fields are camelCase; money fields are **strings** at the boundary.

## Envelope

```ts
type WsEnvelope<T = unknown> = {
  schemaVersion: number   // wire-protocol version (currently 1); clients detect mismatch
  type: string            // SCREAMING_SNAKE, see tables below
  auctionId?: string
  requestId?: string
  seq?: number            // monotonic per auction, no gap
  serverTimeMs: number    // server clock; clients derive serverClockOffsetMs
  data: T
}
```

## Client → Server

| type | data | purpose |
|---|---|---|
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | join room; `lastSeq` replays the missed Stream delta (then `ROOM_SNAPSHOT`); gap > 200 → snapshot only |
| `BID_PLACE` | `{ clientBidId, amountCents: string }` | submit a bid |
| `PING` | `{}` | heartbeat |

## Server → Client

| type | data | purpose |
|---|---|---|
| `ROOM_SNAPSHOT` | `{ status, currentPriceCents, winnerId, endAtMs, seq, rules? }` | room state on join; `rules` is `{ stepCents, capCents, reserveCents, maxExtensions, antiSnipeWindowMs }` |
| `BID_ACCEPTED` | `{ seq, userId, displayName, amountCents, endAtMs, status, serverTimeMs }` | accepted ack (`endAtMs` is post-extension; `status` = `SOLD` on cap-hit else `LIVE`; `serverTimeMs` = Redis-TIME at adjudication) |
| `BID_REJECTED` | `{ code }` | machine-readable (see `error-codes.md`) |
| `AUCTION_EXTENDED` | `{ seq, endAtMs, extendCount }` | anti-snipe extension (event, **not** a state) — T2 |
| `AUCTION_SOLD` | `{ seq, winnerId, amountCents, status }` | terminal SOLD: cap-hit/buy-now (T2), Timer hammer (T3) |
| `AUCTION_NO_BID` | `{ seq, status, serverTimeMs }` | terminal: Timer closed a live auction with no bids (T3) |
| `AUCTION_CANCELLED` | `{ seq, status, serverTimeMs }` | terminal: seller/admin cancel (T3) |
| `SEALED_BID_RECEIVED` | `{ seq, displayName, count, serverTimeMs }` | **redacted** bid-landed ping for `SEALED_FIRST` / `VICKREY` / `ALL_PAY` (issue #114). **No `amountCents`, no `userId`** — the bidder name + running count are all the room sees during LIVE. |
| `AUCTION_REVEALED` | `{ seq, bids:[{userId,displayName,amountCents}], winnerId, amountCents, serverTimeMs }` | sealed-mode reveal at close (issue #114). Emitted **immediately before** `AUCTION_SOLD`; takes its own `seq` and is part of the hash chain. Each revealed bid uses money-as-string `amountCents`. For `VICKREY`, top-level `amountCents` is the **second-highest** price (winner pays runner-up); for `SEALED_FIRST` / `ALL_PAY`, it is the winner's own bid. |
| `ALL_PAY_FORFEIT` | `{ seq, userId, coinsForfeit, serverTimeMs }` | `ALL_PAY` runner-up forfeits their bid (issue #114). Projects to `coin_ledger`, **never** to `orders` — settlement is virtual coins only. |
| `PREQUALIFY_RESULT` | `{ seq, parentAuctionId, formalAuctionId, seededStartPriceCents, qualifiedUserIds?, serverTimeMs }` | `PREQUALIFY` parent's sealed result, emitted when the seller spawns the formal auction (issue #114). Two independent state machines linked by `parent_auction_id`; no cross-auction atomicity. |
| `PONG` | `{}` | heartbeat response |

`amountCents` is a **string** in every payload above (money-as-string boundary). All these events carry a monotonic `seq`; clients apply them through the `seq-guard` (drop duplicates — the originating socket gets both a direct `BID_ACCEPTED` ack and the Pub/Sub broadcast — and out-of-order frames).

## Leaderboard (REST, additive)

`GET /api/auctions/{id}/leaderboard?n=10` → `{ auctionId, leaderboard: [{ userId, amountCents }] }`, top-n by accepted max bid (Redis ZSET), money as string, `n` clamped to `[1,100]`. The live leaderboard ZSET is maintained inside `place_bid.lua`.

> **Sealed-mode gating (issue #114):** while a `SEALED_FIRST` / `VICKREY` / `ALL_PAY` auction is `LIVE`, this endpoint returns `{ sealed: true, leaderboard: [] }` (no amounts, no order). After `AUCTION_SOLD` the revealed list is returned in the normal shape. The gateway price-cache fast-reject is skipped only for sealed-engine modes. `HYBRID_REVEAL` keeps the English-engine fast-reject: the cached broadcast price is the runner-up price, which is always `<=` the true current leader price, so a cached-price rejection remains sound but may be less aggressive than the authoritative Lua check. Lua remains authoritative.

## Auction modes (issue #114) — pluggable strategy

`Rules` gains an optional `mode` field (`""` ≡ `ENGLISH` for back-compat). Catalogue:

| Mode | Hot-path Lua | Reveal at close? | Settlement |
|---|---|---|---|
| `ENGLISH` (default) | `place_bid.lua` / `close_auction.lua` | no | `orders` row from `AUCTION_SOLD` |
| `SUDDEN_DEATH` | same scripts, `MaxExtensions=0` preset | no | `orders` |
| `SEALED_FIRST` | `place_bid_sealed.lua` / `close_auction_sealed.lua` | **yes** (`AUCTION_REVEALED` → `AUCTION_SOLD`) | `orders` at winner's own bid |
| `VICKREY` | `place_bid_sealed.lua` / `close_auction_vickrey.lua` | **yes** | `orders` at **second-highest** price |
| `HYBRID_REVEAL` | `place_bid_hybrid.lua` / `close_auction_hybrid.lua` | **yes** (leader unmasked at close) | `orders` |
| `ALL_PAY` | `place_bid_sealed.lua` / `close_auction_allpay.lua` | **yes** | **`coin_ledger` only — never `orders`** (winner debited + runner-up `ALL_PAY_FORFEIT`). Hard invariant. |
| `PREQUALIFY` | runs a `SEALED_FIRST`; result seeds a formal auction via `POST /api/auctions/{id}/spawn-formal` | **yes** | the SEALED parent's `orders` row is suppressed; the formal child handles settlement. |

**Allowlist gate (server-side):** only `ENGLISH` / `SUDDEN_DEATH` / `SEALED_FIRST` / `VICKREY` / `HYBRID_REVEAL` / `ALL_PAY` are creatable via `POST /api/auctions` (Rules.mode); a request with `PREQUALIFY` or any unknown string returns **HTTP 400** `auction mode not available yet: <MODE>`. A `PREQUALIFY` auction is reached *only* through the parent SEALED → `/spawn-formal` workflow.

**Sealed-broadcast invariant** (the redaction contract that makes 暗拍 sealed):
- The hot-path Lua writes the redacted `SEALED_BID_RECEIVED` shape (`seq, displayName, count, serverTimeMs` — **never** `amountCents`, **never** `userId`) to the Stream + Pub/Sub.
- The same Lua call **returns** the full bid JSON to the gateway so the originating socket's direct `BID_ACCEPTED` ack carries the bidder's own amount. The Stream + Pub/Sub are NEVER the source of the amount during LIVE.
- The sealed ZSET (`auction:{aid}:sealed`, names hash `auction:{aid}:sealednames`) is read-only by the close script; `GET /leaderboard` and `ROOM_SNAPSHOT` do NOT read it during LIVE. After `AUCTION_REVEALED` the ZSET keys are `DEL`d (post-reveal hygiene; amounts are public anyway).

**Close → reveal sequencing** (atomicity across two Lua-emitted events):
```
close_auction_{sealed,vickrey,allpay,hybrid}.lua
  ├─ writes public state (currentPriceCents, winnerId, status=SOLD)
  ├─ XADD <seq+1>-0  AUCTION_REVEALED  + PUBLISH
  └─ XADD <seq+2>-0  AUCTION_SOLD      + PUBLISH
```
Both events are part of the seq-contiguous hash chain (`evidence-card.md`); a replay verifier sees REVEALED before SOLD. No new auction **state** is introduced — sealed reveal happens at close, the state machine stays at the canonical 7 (`DRAFT → SCHEDULED → LIVE → {SOLD | NO_BID | CANCELLED}`).

**Strategy-pattern dispatch** (server-side, not on the wire): `apps/lumen/internal/server/mode.go` selects per-mode `place_bid_*.lua` / `close_*.lua` SHAs at runtime by reading `state.mode` from the room state hash (cached in `Hub.roomState`). The English hot path stays byte-identical (zero regression on the V10k 500-bid/s path).

## Semantics / known limitations (T2)

- **`displayName`** is resolved from the user's nickname **once at WS connect** and cached on the connection. If a profile-rename endpoint lands later, in-flight connections keep the connect-time name in their `BID_ACCEPTED` events until they reconnect (no mid-auction rename today; flagged so evidence-card name drift isn't a surprise).
- **`capPriceCents == 0` = no buy-now ceiling** (open-ended auction). The admin UI must treat a blank cap field deliberately (explicit "no cap" vs. "unspecified") so a seller doesn't unintentionally create an unbounded auction — UI default-value polish is T10.
- **`ROOM_SNAPSHOT.rules.capCents == null` = no buy-now ceiling**. The rules block is additive under schemaVersion 1; old clients can ignore it, new clients should prefer it over local fallback defaults.
- **`ROOM_SNAPSHOT.rules.reserveCents` currently mirrors `startPriceCents`** because the backend rule schema does not yet persist a separate reserve price.
- **Anti-snipe is bounded** by `maxExtensions` (rule DSL; `0` = unlimited). Past the cap an in-window bid is a normal `BID_ACCEPTED` with no `AUCTION_EXTENDED` and no `endAtMs` change.
- A `DUPLICATE` retry on the **same** socket after an extension replays the cached `BID_ACCEPTED` (which already carries the extended `endAtMs`) but **not** the separate `AUCTION_EXTENDED` event; the canonical recovery for a missed event is reconnect + `lastSeq` catchup (implemented in T2: `ROOM_JOIN{lastSeq}` → XRANGE delta replay + snapshot fallback; multi-gateway fanout is T5).
- **Broadcast is Stream-authoritative**: on a Pub/Sub wakeup the gateway reads the canonical Redis Stream from the room's last-broadcast seq and fans out those events. Pub/Sub is a non-authoritative hint — a forged/stale message not backed by the Stream is never broadcast.
- **Every envelope carries `schemaVersion`** (currently `1`) so clients can detect a wire-protocol mismatch; bump on a breaking change (all-member approve).
- **Seller self-bid is rejected** (`BID_REJECTED{ERR_NOT_ALLOWED}`): the seller id is frozen into Redis state and checked on the hot path (anti shill-bidding).
- **Money is bounded by `MaxMoneyCents` (2^53-1)** and stored as exact decimal strings; larger amounts are rejected (`ERR_BAD_INPUT` at the gateway, `ERR_TOO_LOW` defensively in Lua) because float64 (Lua / JS / Redis ZSET score) can't represent them exactly.
- **Backpressure — two-lane (T5)**: each connection has a **CRITICAL** lane (bid acks, `AUCTION_*` events incl. `AUCTION_EXTENDED`, `ROOM_SNAPSHOT`, catchup) and a **BEST-EFFORT** lane (`PONG` is the **only** type on this lane in v0 — see "Lossy lane policy" below). The critical buffer (`sendBufFrames=256`) is sized to exceed `catchupMaxGap=200` so a full Stream replay never trips force-close. A full critical lane **force-closes** the connection with **typed close code `4000 BACKPRESSURE_DROP`** (client reconnects + re-syncs via catchup/`ROOM_SNAPSHOT` — never a silent loss of a critical event); a full best-effort lane **drops the individual frame** and keeps the connection. The critical lane is drained with **best-effort priority** (a pending critical frame pre-empts a pending lossy one in the leading non-blocking poll; under Go's pseudo-random select fairness a critical frame can be delayed by at most one in-flight lossy write). All sends are non-blocking so one slow client never stalls the room broadcast.
- **WS keepalive (T5-followup)**: the server PINGs every `pingPeriod=54s` and tears down any client that doesn't PONG within `pongWait=60s`. Without keepalive a silently-dead client (cable pulled, NAT timeout, OS sleep, mobile data hand-off) blocks `ws.ReadMessage()` for the OS-level TCP timeout (~2h on Linux), leaking one read + one writePump goroutine per dead conn AND keeping it in `hub.rooms`. Healthy clients (default gorilla / browser behavior) auto-PONG and never trip it.
- **Typed close codes (T5-followup)**: WS spec reserves `4000-4999` for application use (RFC 6455 §7.4.2). `4000 BACKPRESSURE_DROP` is emitted on the critical-lane overflow path so a client can distinguish a server-initiated backpressure-drop from a raw network failure (back off + reconnect with state catchup, not a tight reconnect loop). The CLOSE frame is **emitted from the per-connection `writePump`** (single-writer goroutine), not from the broadcast loop — the broadcast goroutine only records the intent (code + reason) and signals shutdown, so a congested slow client can't pin `hub.RLock` waiting on its CLOSE-frame write. The actual `ws.WriteControl` runs on `writePump`'s exit path with a tight `closeFrameWait=1s` deadline (best-effort: if the socket won't drain in 1s, the upstream `ws.Close()` races to RST and the client surfaces a generic 1006 instead of typed 4000). Other server-side close paths use the implicit close (`code=1006` at the wire when the socket just closes).
- **Lossy lane policy (T5-followup)**: a frame qualifies for the lossy lane only if a **silent client-visible drop is acceptable**. v0 ships only `PONG` (replaceable: the next ping refreshes the deadline). Future additions (chat / presence) are per-type decisions — a 5 msg/s chat into the 16-slot lossy buffer overflows in 3 seconds with silent drops, which is a UX bug, not a feature. Default-route to the CRITICAL lane; only re-route to lossy after deciding the type IS replaceable AND the buffer cap is right for its rate.
- **Outbound frame size bound (T5-followup)**: server writes bounded at `maxOutboundFrameBytes=32 KiB` (matches inbound `maxWSFrameBytes`). Today's frames are small (`BID_ACCEPTED` ~200 B, `ROOM_SNAPSHOT` ~150 B); the bound is defensive — a future contributor pushing a fat event payload gets a logged fail-fast at the write boundary rather than weird socket behavior.

## T1 / T2 subset

T1 exercises `ROOM_JOIN → ROOM_SNAPSHOT`, `BID_PLACE → BID_ACCEPTED`, and room broadcast of `BID_ACCEPTED`. **T2** adds `AUCTION_EXTENDED` (anti-snipe) + `AUCTION_SOLD` (cap-hit) broadcasts, the client `seq-guard`, Stream-authoritative broadcast, `lastSeq` catchup, and `schemaVersion`. **T3** lands the remaining terminal events. **T5** lands the two-lane backpressure split (critical vs best-effort) and validates multi-gateway fanout (each gateway fans out the canonical Stream to its own room members; no shared in-process hub).

## Countdown

```text
remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)
```
Redis TIME is the adjudication clock; expiry boundary is `now >= endAtMs`. Video is non-authoritative.
