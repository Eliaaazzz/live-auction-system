# WebSocket Protocol

Source basis: RFC v1 §8 plus Issue #3 scope. Day-2 protocol freeze should keep JSON examples debuggable even if production chooses msgpack.

## Envelope

```ts
type WsEnvelope<T = unknown> = {
  type: string
  auctionId?: string
  requestId?: string
  traceId?: string
  serverInstanceId?: string
  seq?: number
  serverTimeMs: number
  data: T
}
```

Money fields such as `amount_cents` are strings at the protocol boundary to avoid JavaScript number ambiguity.

## Client To Server

| type | data | purpose |
|---|---|---|
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | Join room and request catchup. |
| `ROOM_LEAVE` | `{ auctionId }` | Leave room. |
| `BID_PLACE` | `{ clientBidId, amountCents }` | Submit bid. |
| `PING` | `{}` | Heartbeat. |
| `CHAT_SEND` | `{ text }` | Soft room channel. |

## Server To Client

| type | purpose |
|---|---|
| `ROOM_SNAPSHOT` | Current price, winner, leaderboard, `endAtMs`, `seq`, state. |
| `CATCHUP_EVENTS` | Stream replay from `lastSeq + 1`. |
| `BID_ACCEPTED` | Accepted bid ack with `seq`, amount, and updated time. |
| `BID_REJECTED` | Rejected bid with machine-readable error code. |
| `USER_OUTBID` | Current user was surpassed. |
| `AUCTION_EXTENDED` | Anti-snipe extension event; not a state. |
| `AUCTION_SOLD` | Terminal sold event. |
| `AUCTION_NO_BID` | Terminal no-bid/passed event. |
| `AUCTION_CANCELLED` | Abnormal cancellation. |
| `PONG` | Heartbeat response. |

## Error Codes

Issue #3 freezes the bid rejection code set through the WebSocket contract. Redis/Lua codes used by the protocol are:

`OK_ACCEPTED`, `OK_SOLD`, `DUPLICATE`, `ERR_NOT_LIVE`, `ERR_TOO_LOW`, `ERR_AFTER_END`, `ERR_RATE_LIMITED`, `ERR_AUCTION_PAUSED`, `OK_CANCELLED`, `OK_NO_BID`, `ERR_NOT_DUE`, `ERR_ALREADY_TERMINAL`, `ERR_NOT_ALLOWED`.

Backpressure policy follows V8: bid-critical messages must not be blocked by soft chat/AI traffic. Watch WebSocket `bufferedAmount` at 1MB/4MB thresholds and degrade soft channels first.

## Countdown Clock

Clients do not trust local time alone:

```text
remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)
```

`serverClockOffsetMs` is calibrated from `serverTimeMs` in snapshots and events. Redis TIME is the adjudication source, with expiry boundary `now >= ends_at_ms`.
