# Runner-Up Pays Mode

Status: design note for post-foundation review. This mode must not be wired into
runtime until the pluggable-mode contract in issue #114 is ratified and merged.

## Summary

`RUNNER_UP_PAYS` is an experimental game-theory auction mode:

- highest eligible bidder wins the item
- second-highest eligible bidder bears the liability
- liability is virtual coins only
- no real order, checkout, fiat payment, or captured payment method is allowed
- if fewer than two eligible bidders exist at close, there is no runner-up
  liability

The mechanic is intentionally distinct from the existing proposed modes:

| Mode | Winner | Price or liability |
|---|---|---|
| `VICKREY` | highest sealed bidder | winner pays second-highest price |
| `ALL_PAY` | highest bidder | winner plus runner-up virtual-coin settlement |
| `RUNNER_UP_PAYS` | highest bidder | runner-up alone carries capped virtual liability |

## Product guardrails

This mode is easy to misread as a real-money loss mechanic, so the product gate
is stricter than normal modes.

- Seller must explicitly opt in.
- Buyers must explicitly opt in before they can bid in this room.
- UI copy must say "virtual coins only", "no real payment", and "experimental".
- Liability must have a per-auction cap.
- An optional per-user deposit cap should limit repeated escalation.
- The winner's real checkout path must stay disabled until a legal/product
  review explicitly approves otherwise.
- Evidence must show the mode version and caps so replay is auditable later.

## Runtime contract sketch

The authoritative state still belongs in Redis Lua. The gateway may display rank
information, but it cannot adjudicate liability.

Suggested Redis state:

- `state.mode = RUNNER_UP_PAYS`
- `state.liabilityCapCents`
- `state.modeVersion`
- leaderboard ZSET remains keyed by bidder with max bid amount
- optional per-user liability/deposit state is separate from real payment state

Suggested stream events:

- `BID_ACCEPTED` remains the normal accepted-bid event.
- `RUNNER_UP_LIABILITY_UPDATED` is optional live telemetry for rank 2.
- `RUNNER_UP_SETTLED` is emitted at close when there is a liable runner-up.
- `AUCTION_SOLD` may still identify the winner, but order creation must be
  skipped or explicitly marked as virtual-only for this mode.

All money-like fields remain strings. The mode is additive under schema version
1 only if old clients can ignore the new events without breaking the English
auction path.

## Close-time settlement

At close, Lua should atomically derive the top two eligible bidders from backend
state:

1. No eligible bids: close as `NO_BID`.
2. One eligible bidder: winner may be declared, but there is no runner-up
   liability.
3. Two or more eligible bidders: highest bidder is winner, second-highest bidder
   receives virtual liability up to the configured cap.

The close path must emit all settlement events in one contiguous sequence so the
Replay Verifier and evidence HMAC chain prove the exact result.

## Evidence requirements

The evidence card should include:

- mode: `RUNNER_UP_PAYS`
- mode version
- winner id or display name
- runner-up id or display name when present
- winner bid amount
- runner-up liability amount
- liability cap
- whether buyer opt-in was required and satisfied
- settlement type: `VIRTUAL_COINS_ONLY`

It must be impossible for this mode to create a normal fiat `orders` row unless a
future contract explicitly changes that rule.

## Tests before runtime wiring

Minimum tests before implementation can merge:

- no-bid close produces no liability
- one-bidder close produces no runner-up liability
- normal top-2 close assigns winner and capped runner-up liability
- same bidder rebids only counts as one eligible bidder
- cap hit clamps liability
- tied amount behavior is deterministic and documented
- replay verifier remains consistent
- evidence chain includes the settlement events
- zero normal `orders` rows for this mode
- buyer without explicit opt-in cannot bid

## Implementation phases

1. Contract first: add mode enum, events, evidence fields, and zero-real-payment
   invariant to `proto/*`.
2. Backend model: add mode validation and caps without changing existing English
   mode behavior.
3. Redis Lua: add a dedicated place/close script pair that maintains top-two
   state and settles from authoritative data only.
4. Persistence: project virtual settlement separately from normal orders.
5. Frontend: show rank-1/rank-2 liability, opt-in gate, caps, and virtual-only
   labels.
6. Demo: add a dedicated `make demo-runner-up-pays` gate after the core mode
   foundation is stable.

## Open decisions

- Whether the winner pays anything in the demo, or the item transfer is purely
  symbolic while only the runner-up receives virtual liability.
- Whether liability is based on the runner-up's own bid or capped at a separate
  configured amount.
- Whether the mode is shown before freeze or kept as a post-demo stretch.
- Whether opt-in is per auction, per user session, or per bid.
