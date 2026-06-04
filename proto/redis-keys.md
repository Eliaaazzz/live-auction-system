# Redis Keys & Lua Contracts

Materialized from PR #13 `docs/redis-keys.md`. All auction-local keys share the cluster hash tag `{<aid>}` so multi-key Lua stays in one slot. Lua has no rollback → type-guard + validate before write; business code must never write hot keys directly.

## Keys

```text
auction:{<aid>}:state        Hash   status,currentPriceCents,winnerId,endAtMs,seq,
                                    startPriceCents,incrementCents,capPriceCents,
                                    extendWindowSec,extendSec,maxExtensions,extendCount,
                                    sellerId,paused
                                    (money fields stored as exact decimal STRINGS,
                                     <= MaxMoneyCents 2^53-1, never float-formatted)
auction:{<aid>}:leaderboard  ZSET   member=userId  score=accepted max amountCents
auction:{<aid>}:dedupe:{uid} Hash   clientBidId -> result json   (TTL 24h)
auction:{<aid>}:events       Stream durable ordered log; Stream ID = <seq>-0
auction:{<aid>}:pub          Pub/Sub wakeup hint only (non-authoritative); on a hint
                                    the gateway reads the Stream and fans out — a forged
                                    pub message not backed by the Stream is never broadcast
auction:active               ZSET   member=auctionId score=endAtMs (Timer Worker index).
                                    Global (not {<aid>}-tagged), so the Lua hot path never
                                    touches it; Go maintains it (StartAuction ZADD, Timer
                                    ZREM on close, cancel ZREM). close_auction re-checks
                                    Redis TIME, so a stale score only costs a retry.
```

## P0 Lua scripts

`start_auction.lua`, `freeze_rules.lua`, `place_bid.lua`, `close_auction.lua` (T3), `cancel_auction.lua` (T3). **No `*_v2.lua`.** All loaded via `SCRIPT LOAD` at startup, SHA cached, called by `EVALSHA`.

### `freeze_rules.lua(KEYS=[state], ARGV=[rulesJson, sellerId])`  — **NEW contract (all-member approve)**
`DRAFT → SCHEDULED`. Copies rule fields **and `sellerId`** into `state` Hash; **does NOT consume the bid `seq`** (seq is the event sequence; first bid = seq 1). Type-guards `state` before write.
Returns: `OK_FROZEN` · `ERR_BAD_STATE(status | 'key_type')`.
Seller ownership is enforced in **Go** (authoritative against MySQL); `sellerId` is also copied into `state` so `place_bid.lua` can reject seller self-bids on the hot path (T2).

### `start_auction.lua(KEYS=[state], ARGV=[durationMs])`  — **NEW contract (all-member approve)**
`SCHEDULED → LIVE`. Sets `endAtMs = redisNow + durationMs`, `status=LIVE`; **does NOT consume the bid `seq`**. Type-guards `state` before write.
Returns: `OK_LIVE(endAtMs)` · `ERR_BAD_STATE(status | 'key_type')`. On `OK_LIVE` the Go layer `ZADD`s the auction into `auction:active` for the Timer Worker.

### `place_bid.lua` — **T2 atomic core (all-member approve: Lua return)**
`EVALSHA KEYS=[state, leaderboard, events, dedupe:{userId}] ARGV=[userId, clientBidId, amountCents, displayName, pubChannel]`

Validation order (each step before any write; Lua has no rollback): type-guard all 4 keys → dedupe short-circuit → `paused` → `status==LIVE` → **seller self-bid** (`userId==sellerId` → `ERR_NOT_ALLOWED`) → `now < endAtMs` (Redis TIME, `>=` loses to close) → amount range → **stream/state seq preflight**. Then accept atomically: `HINCRBY seq` → `HMSET currentPriceCents/winnerId` (string-exact) → `ZADD leaderboard GT amount userId` (keeps each member's accepted max) → optional anti-snipe / cap transition → `XADD <seq>-0` → `HSET dedupe` (24h TTL) → `PUBLISH`.

**Seller self-bid** (`ERR_NOT_ALLOWED`): a bid whose `userId == state.sellerId` is rejected (anti shill-bidding; §8 authz), no seq/event mutation.

**Amount range** (single `ERR_TOO_LOW` namespace, error-codes.md): the cap-aware required price is `required = min(currentPriceCents + incrementCents, capPriceCents>0 ? capPriceCents : ∞)`, so a buy-now bid can reach the cap even when the increment overshoots it. Reject when `amount < required`, when `amount > capPriceCents` (`capPriceCents>0`; over-cap is rejected, not clipped — per #1), or when `amount > MaxMoneyCents` (2^53-1, float64 precision ceiling). `capPriceCents == 0` means no buy-now ceiling. **Creation guard** (`Rules.Validate`): a no-cap auction whose first required bid `startPriceCents + incrementCents` exceeds `MaxMoneyCents` is rejected at create time — otherwise it is unwinnable (every bid > the ceiling). With a cap the required price clamps to the cap, so a cap below the first increment stays valid. Money is read for comparison via `tonumber` but **written as the canonical decimal string** (HMSET/ZADD) so values up to the ceiling stay exact.

**Preflight** (validate-before-write): the stream's last entry seq must equal `state.seq` before any mutation; a desync (out-of-band `XADD`) returns `ERR_INTERNAL('seq_stream_mismatch')` with **no dirty write** (the explicit `<seq>-0 XADD` would otherwise error after seq/price/leaderboard were already changed).

**Anti-snipe** (`OK_EXTENDED`): when not a cap-hit and `extendWindowSec > 0` and `extendSec > 0` and `endAtMs - now <= extendWindowSec*1000` **and** `extendCount < maxExtensions` (`maxExtensions == 0` = unlimited) → `endAtMs += extendSec*1000`, `HINCRBY extendCount`, and emit a second `AUCTION_EXTENDED` event. **No separate `extend.lua`.** Past the extension cap an in-window bid is accepted as a normal `OK_ACCEPTED` (no `endAtMs` bump, no `AUCTION_EXTENDED`) — this bounds the auction lifetime against two bidders bouncing the price inside the window.

**Cap-hit / buy-now** (`OK_SOLD`): when `capPriceCents > 0` and `amount >= capPriceCents` → `status=SOLD` (terminal) and emit a second `AUCTION_SOLD` event. Cap-hit takes priority over anti-snipe.

**Secondary events consume their own `seq`** (a second `HINCRBY`) so every Stream entry keeps a unique `<seq>-0` id and the client seq-guard sees a gap-free log: `OK_EXTENDED`/`OK_SOLD` write `BID_ACCEPTED` at `seq` then `AUCTION_EXTENDED`/`AUCTION_SOLD` at `seq+1`.

Returns:
| code | shape |
|---|---|
| `OK_ACCEPTED` | `{code, seq, bidJson}` |
| `OK_EXTENDED` | `{code, seq, bidJson, seq2, extJson}` |
| `OK_SOLD` | `{code, seq, bidJson, seq2, soldJson}` |
| `DUPLICATE` | `{code, bidJson}` (cached original ack; **not** an error) |
| `ERR_NOT_LIVE` | `{code, status}` |
| `ERR_AFTER_END` | `{code, endAtMs, now}` |
| `ERR_TOO_LOW` | `{code, amount, required}` (below required, over cap, or over MaxMoneyCents) |
| `ERR_NOT_ALLOWED` | `{code, 'seller_self_bid'}` (wire: `BID_REJECTED{ERR_NOT_ALLOWED}`) |
| `ERR_AUCTION_PAUSED` | `{code}` |
| `ERR_INTERNAL` | `{code, 'key_type' \| 'seq_stream_mismatch'}` |

`bidJson` (also the dedupe-cached ack and the Stream `BID_ACCEPTED` payload) = `BidAcceptedData{seq,userId,displayName,amountCents,endAtMs,status,bidCount,serverTimeMs}` where `endAtMs` is the post-extension value, `status` is `SOLD` on a cap-hit else `LIVE`, and `bidCount` is atomically incremented in the same Lua accept path as `seq`. The gateway acks the originating socket with `BID_ACCEPTED(bidJson)` for all accept codes; the `AUCTION_EXTENDED`/`AUCTION_SOLD` event reaches the room via Pub/Sub.

**Pub/Sub fanout message** (`auction:{<aid>}:pub`, non-authoritative): `{type, seq, data}` (`PubMessage`) — `type` is the wire type (`BID_ACCEPTED` / `AUCTION_EXTENDED` / `AUCTION_SOLD`), `data` is that type's payload. The gateway subscriber re-emits it as a WS envelope verbatim; the durable Stream remains the source of truth.

Invariants (frozen, RFC v2): single `seq` (`HINCRBY state seq`); Stream ID `<seq>-0`; Redis TIME authoritative, boundary `>=`; dedupe Hash returns original ack on retry; AOF everysec, Redis down → `ERR_AUCTION_PAUSED`. **`event_hash` is NOT computed in Lua** — Persistence Worker computes it on the MySQL projection (T4).

### `close_auction.lua(KEYS=[state, events], ARGV=[pubChannel])` — **T3 (all-member approve: Lua return)**
Timer Worker-triggered hammer — does NOT depend on the next bid. type-guard → require `status==LIVE` (else `ERR_ALREADY_TERMINAL`) → Redis TIME re-check `now >= endAtMs` (else `ERR_NOT_DUE(endAtMs, now)`; an anti-snipe extension since the scan lands here) → stream/state seq preflight → `HINCRBY seq` → set terminal status + emit one event:
- winner present (`winnerId != ''`) → `status=SOLD`, `AUCTION_SOLD` at `<seq>-0` → `OK_SOLD(seq, soldJson)`
- no winner → `status=NO_BID`, `AUCTION_NO_BID` at `<seq>-0` → `OK_NO_BID(seq, noBidJson)`

Returns: `OK_SOLD` · `OK_NO_BID` · `ERR_NOT_DUE(endAtMs, now)` · `ERR_ALREADY_TERMINAL(status)` · `ERR_INTERNAL('key_type' | 'seq_stream_mismatch')`. Reuses the single `seq` + `<seq>-0` invariants; the terminal event publishes a wakeup so the gateway fans it out from the Stream.

### `cancel_auction.lua(KEYS=[state, events], ARGV=[callerId, pubChannel])` — **T3 (all-member approve: Lua return)**
Seller/admin cancel of a non-terminal **frozen** auction (SCHEDULED/LIVE; an unfrozen DRAFT has no Redis state and is a MySQL-only status flip in Go). type-guard → reject terminal/absent (`ERR_ALREADY_TERMINAL`) → `callerId == state.sellerId` else `ERR_NOT_ALLOWED('not_owner')` (defensive; Go also verifies vs MySQL) → seq preflight → `HINCRBY seq` → `status=CANCELLED`, `AUCTION_CANCELLED` at `<seq>-0` → `OK_CANCELLED(seq, cancelJson)`.
Returns: `OK_CANCELLED` · `ERR_NOT_ALLOWED('not_owner')` · `ERR_ALREADY_TERMINAL(status)` · `ERR_INTERNAL(...)`.

**Terminal status projection (T3):** `auctions.status` for SOLD/NO_BID/CANCELLED is projected by the **Persistence Worker** from the Stream terminal event (single source — covers cap-hit SOLD via `place_bid`, the Timer hammer, and cancel). `freeze`/`start` statuses (SCHEDULED/LIVE) are set by their REST handlers (they emit no Stream event).
