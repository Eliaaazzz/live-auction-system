# WebSocket Envelope & Protocol — v1 (DRAFT)

Owner: @A (Realtime Engineer) · Status: DRAFT — freeze by **Day 2 (2026-05-20)**
Source of truth: this file. PR-only changes after freeze; breaking changes need owner + 1 approve.

---

## Goals

- Single TCP WS connection per client, logically multiplexed into 4 channels.
- Authoritative server `seq` for ordering and gap detection on the `bid` channel.
- Backpressure with 3 priority queues per connection: `critical` / `normal` / `drop_ok`.
- Reliable catchup after reconnect (no lost accepted bids on the client's screen).

## Transport

- Endpoint: `wss://<host>/ws?token=<jwt>`
- Encoding: `msgpack` (canonical, sorted keys) — JSON fallback for dev (`?fmt=json`).
- Heartbeat: client sends `ping` every 15s; server disconnects after 30s of silence.
- Max frame size: 64 KiB. Larger payloads MUST be served via REST.

## Envelope

```ts
type Envelope<T = unknown> = {
  v: 1;                                                       // protocol version
  ch: 'bid' | 'presence' | 'chat' | 'ai';                     // logical channel
  t: string;                                                  // event type (see below)
  auction_id?: string;
  req_id?: string;                                            // request/ack correlation (client-set)
  seq?: number;                                               // server-assigned, AUTHORITATIVE for `bid`
  ts_ms: number;                                              // server timestamp in ms
  priority?: 'critical' | 'normal' | 'drop_ok';               // server hint for writer queues
  body: T;
};
```

## Channels

| channel    | direction       | priority           | example events                                                |
|------------|-----------------|--------------------|---------------------------------------------------------------|
| `bid`      | both            | `critical`         | `bid.place` (C→S), `bid.accepted/rejected` (S→C), `state.changed` (S→C) |
| `presence` | server → client | `drop_ok` (coalesced) | `presence.snapshot`                                       |
| `chat`     | both            | `drop_ok`          | `chat.message`                                                |
| `ai`       | server → client | `normal`           | `ai.host.text`, `ai.host.start`, `ai.host.end`                |

## Client → Server events

| `t`              | body                                                              | rate limit         |
|------------------|-------------------------------------------------------------------|--------------------|
| `room.join`      | `{ auction_id, last_seen_seq?: number }`                          | 5/min/user         |
| `room.leave`     | `{ auction_id }`                                                  | —                  |
| `bid.place`      | `{ client_bid_id: uuid, amount_cents: int, last_seen_seq?: int }` | **5/sec/user/auction** |
| `chat.message`   | `{ text: string<=200 }`                                           | 3/sec/user/room    |
| `catchup.request`| `{ auction_id, since_seq }`                                       | 1/sec/user         |

## Server → Client events

| `t`                  | body                                                                                                       |
|----------------------|------------------------------------------------------------------------------------------------------------|
| `room.joined`        | `{ snapshot: AuctionSnapshot, server_seq: int }`                                                           |
| `bid.accepted`       | `{ seq, user_id, amount_cents, ends_at_ms }`                                                               |
| `bid.rejected`       | `{ req_id, code, ...details }` (see Error codes)                                                           |
| `state.changed`      | `{ state, seq, ends_at_ms?, winner_id?, final_amount_cents? }`                                             |
| `rule.changed`       | `{ rules: AuctionRules, frozen_at_seq }` (open-time freeze, or P1 seller-confirmed runtime change)         |
| `presence.snapshot`  | `{ online_count: int }`                                                                                    |
| `chat.message`       | `{ user_id, text, ts_ms }`                                                                                 |
| `ai.host.text`       | `{ trigger: string, partial?: bool, text: string, final?: bool }` (streaming token-by-token)               |
| `catchup.batch`      | `{ events: Envelope[], next_seq, has_more }`                                                               |
| `snapshot.required`  | `{ auction_id, reason: 'stream_truncated' }` → client MUST hit REST `/auctions/{id}/snapshot`              |

## Error codes (in `bid.rejected.body.code`)

| code                    | meaning                                            |
|-------------------------|----------------------------------------------------|
| `not_bidding`           | auction state not in `Bidding`/`Cooling`           |
| `auction_paused`        | Redis temporarily unavailable                      |
| `too_low`               | amount < cur + step (body has `cur_cents`, `step_cents`) |
| `after_hammer`          | `now_ms > ends_at_ms`                              |
| `duplicate_bid`         | `client_bid_id` already accepted                   |
| `rate_limited`          | exceeded 5/sec                                     |
| `unauthorized`          | JWT invalid/expired or not in room                 |
| `stream_append_failed`  | Redis XADD failed (server self-rejects, retry safe)|

## Catchup protocol

1. Client reconnects, sends `room.join` with `last_seen_seq = N`.
2. Server:
   - If `N == current_seq` → reply `room.joined` with snapshot only.
   - Else `XRANGE auction:{aid}:events` for entries with `seq > N`, send via `catchup.batch` (chunked if `> 200`).
   - If oldest available `seq > N + 1` (Stream window exceeded) → send `snapshot.required` and let client refetch.
3. Client applies events in seq order, drops any with `seq <= last_seen_seq`.

## Backpressure

Per-connection writer maintains 3 queues with strict priority:
- `critical` queue: bid/state/rule events. Drained first, unbounded (small messages).
- `normal` queue: ai/host events. Bounded to 100; oldest dropped if full.
- `drop_ok` queue: presence/chat. Bounded to 200; new dropped if full.
- `presence.snapshot` is **coalesced** — only the most recent retained.
- If `critical` queue grows past 50 (slow client), connection is closed with `policy_violation` — client reconnects + catchup.

## Versioning

- `v: 1` is current. Field additions are non-breaking (clients ignore unknown).
- Breaking change → bump `v` and run both versions in parallel for one sprint.

## Open questions

- [ ] Should `room.joined` snapshot include top-N ranking, or only current max? (Recommend top-10 for UI bootstrap.)
- [ ] Add `bid.preview` for AI suggested step? (P1, skip for now.)
- [ ] How to distinguish "demo bot bidder" from real users on `presence.snapshot`?
