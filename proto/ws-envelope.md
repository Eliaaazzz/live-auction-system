# WS Envelope Contract

Materialized from PR #13 `docs/ws-protocol.md`. Encoding: **JSON-only** in T1 (msgpack is Stretch). `type` is **SCREAMING_SNAKE**; envelope fields are camelCase; money fields are **strings** at the boundary.

## Envelope

```ts
type WsEnvelope<T = unknown> = {
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
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | join room; `lastSeq` requests catchup (catchup itself is T5) |
| `BID_PLACE` | `{ clientBidId, amountCents: string }` | submit a bid |
| `PING` | `{}` | heartbeat |

## Server → Client

| type | data | purpose |
|---|---|---|
| `ROOM_SNAPSHOT` | `{ status, currentPriceCents, winnerId, endAtMs, seq }` | room state on join |
| `BID_ACCEPTED` | `{ seq, userId, displayName, amountCents, endAtMs, status }` | accepted ack (`endAtMs` is post-extension; `status` = `SOLD` on cap-hit else `LIVE`) |
| `BID_REJECTED` | `{ code }` | machine-readable (see `error-codes.md`) |
| `AUCTION_EXTENDED` | `{ seq, endAtMs, extendCount }` | anti-snipe extension (event, **not** a state) — T2 |
| `AUCTION_SOLD` | `{ seq, winnerId, amountCents, status }` | terminal SOLD: cap-hit/buy-now (T2), Timer hammer (T3) |
| `AUCTION_NO_BID` / `AUCTION_CANCELLED` | terminal events (T3) |
| `PONG` | `{}` | heartbeat response |

`amountCents` is a **string** in every payload above (money-as-string boundary). All these events carry a monotonic `seq`; clients apply them through the `seq-guard` (drop duplicates — the originating socket gets both a direct `BID_ACCEPTED` ack and the Pub/Sub broadcast — and out-of-order frames).

## Leaderboard (REST, additive)

`GET /api/auctions/{id}/leaderboard?n=10` → `{ auctionId, leaderboard: [{ userId, amountCents }] }`, top-n by accepted max bid (Redis ZSET), money as string, `n` clamped to `[1,100]`. The live leaderboard ZSET is maintained inside `place_bid.lua`.

## T1 / T2 subset

T1 exercises `ROOM_JOIN → ROOM_SNAPSHOT`, `BID_PLACE → BID_ACCEPTED`, and room broadcast of `BID_ACCEPTED`. **T2** adds `AUCTION_EXTENDED` (anti-snipe) and `AUCTION_SOLD` (cap-hit) broadcasts and the client `seq-guard`. Backpressure channels (critical/presence/chat/ai), catchup, and the remaining terminal events are wired in their gating T-steps (T3/T5).

## Countdown

```text
remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)
```
Redis TIME is the adjudication clock; expiry boundary is `now >= endAtMs`. Video is non-authoritative.
