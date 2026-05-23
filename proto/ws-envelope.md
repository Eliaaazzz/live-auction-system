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

| type | purpose |
|---|---|
| `ROOM_SNAPSHOT` | current price, winner, `endAtMs`, `seq`, status on join |
| `BID_ACCEPTED` | accepted ack: `seq`, `amountCents`, `endAtMs`, `status` |
| `BID_REJECTED` | `{ code }` machine-readable (see `error-codes.md`) |
| `AUCTION_EXTENDED` | anti-snipe extension (event, **not** a state) — emitted from T2/T3 |
| `AUCTION_SOLD` / `AUCTION_NO_BID` / `AUCTION_CANCELLED` | terminal events (T3) |
| `PONG` | heartbeat response |

## T1 subset

T1 exercises `ROOM_JOIN → ROOM_SNAPSHOT`, `BID_PLACE → BID_ACCEPTED`, and room broadcast of `BID_ACCEPTED`. Backpressure channels (critical/presence/chat/ai), catchup, and the terminal/extended events are wired in their gating T-steps (T2/T3/T5).

## Countdown

```text
remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)
```
Redis TIME is the adjudication clock; expiry boundary is `now >= endAtMs`. Video is non-authoritative.
