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
| `PONG` | `{}` | heartbeat response |

`amountCents` is a **string** in every payload above (money-as-string boundary). All these events carry a monotonic `seq`; clients apply them through the `seq-guard` (drop duplicates — the originating socket gets both a direct `BID_ACCEPTED` ack and the Pub/Sub broadcast — and out-of-order frames).

## Leaderboard (REST, additive)

`GET /api/auctions/{id}/leaderboard?n=10` → `{ auctionId, leaderboard: [{ userId, amountCents }] }`, top-n by accepted max bid (Redis ZSET), money as string, `n` clamped to `[1,100]`. The live leaderboard ZSET is maintained inside `place_bid.lua`.

**Mode-aware gating during `LIVE`** (mirrors the WS Stream broadcast redaction so REST cannot become a back-door for sealed amounts):

| Mode | LIVE response | Terminal response |
|---|---|---|
| `ENGLISH` / `SUDDEN_DEATH` / `PREQUALIFY` | full top-n | full top-n |
| `SEALED_FIRST` / `VICKREY` / `ALL_PAY` | **empty array** (sealed surface — no participant or amount exposure) | full top-n |
| `HYBRID_REVEAL` | top-n **with the current leader filtered out** (runner-up + below remain visible, matching the WS Stream's redacted top-bid broadcast) | full top-n incl. winner |

Gating is computed server-side off the live `auction:{aid}:state` hash (`status` / `mode` / `winnerId`) in a single `HMGET`, so clients cannot bypass it by raising `n`. Once the auction reaches a terminal state (`SOLD` / `NO_BID` / `CANCELLED` / `ORDER_CREATED`), the full leaderboard is returned for all modes — the redaction is a fairness-during-bidding rule, not a permanent secret.

## Auction snapshot (REST first paint, additive)

`GET /api/auctions/{id}` includes top-level `livePlayUrl?: string` (issue #121). It is an optional HLS `.m3u8` / mp4 / webm URL the room player renders as the 直播画面 on first paint. **Non-authoritative**: it is display-only, never gates bids, close, evidence, or any Redis/WS state transition. Empty/absent → the room falls back to the simulated feed (CSS sheen, #110).

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
