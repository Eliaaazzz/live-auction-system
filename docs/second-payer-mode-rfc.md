# Second-Payer Auction Mode RFC

Status: proposal only. The default product remains the current known-item ascending auction.

Source basis: `docs/state-machine.md` defines the current DRAFT -> SCHEDULED -> LIVE -> SOLD/NO_BID/CANCELLED -> ORDER_CREATED flow; `proto/db-schema.md` shows current `auctions`, `bids`, `orders`, and `auction_events`; `apps/lumen/internal/model/model.go` shows the current wire payloads where `AUCTION_SOLD` carries `winnerId` and `amountCents` only.

## Summary

This RFC defines an optional game mode where normal live bidding still happens, the highest qualified bidder receives the item, and the second-highest qualified bidder is the payer.

This is not the classic second-price auction where the winner pays the second price. It is a runner-up-pays mode. That makes it interesting as a game-theory demo, but it also creates stronger fairness, liability, and collusion risks than the current auction. It must stay opt-in, visibly labeled, and feature-flagged until reviewed.

## Product rule

Mode name: `SECOND_PAYER`.

Eligible participants must explicitly opt into the mode before they can bid. The UI must show that the highest bidder may receive the item without paying, while the runner-up may pay without receiving the item.

A valid close has two distinct qualified bidders:

| Role | Selection rule | Settlement |
|---|---|---|
| Winner | highest final bid, tie-broken by earlier accepted seq | receives the item |
| Payer | second-highest final bid from a different user, tie-broken by earlier accepted seq | pays `payerAmountCents` |

`payerAmountCents` equals the payer's own final accepted bid, capped by the frozen mode liability limit.

If fewer than two distinct qualified bidders have accepted bids at close, the auction must not create a second-payer order. The implementation should add an explicit close reason, for example `closeReason: "NO_SECOND_PAYER"`, instead of overloading ordinary `NO_BID` semantics.

## Required frozen rules

`SECOND_PAYER` must be frozen with the existing auction rules before `LIVE` starts. The rule set needs these additional immutable fields:

| Field | Purpose |
|---|---|
| `settlementMode` | `STANDARD_ASCENDING` or `SECOND_PAYER` |
| `secondPayerLiabilityCapCents` | maximum amount any runner-up can be charged |
| `secondPayerMinDistinctBidders` | should be `2` for this mode |
| `secondPayerDisclosureVersion` | immutable UI/legal copy version acknowledged by bidders |

A bidder's accepted amount must never exceed their accepted liability cap. For demo safety, the cap should also be bounded by the seller's frozen auction cap. Do not allow uncapped runner-up liability.

## Backend design constraints

The hot path must remain Redis Lua adjudicated. No MySQL read or LLM call can be introduced into bid acceptance.

Redis should maintain enough state to settle the top two distinct bidders atomically:

| Redis state | Requirement |
|---|---|
| current leader | existing highest accepted bid and seq |
| per-user best bid | latest best bid for each user, for same-user rebids |
| ranked bidders | top distinct bidders by amount, then earlier seq |
| liability cap | frozen per auction and enforced in Lua |

At close, `close_auction.lua` or the Timer Worker path must derive both `winnerId` and `payerId` from Redis state and write one durable Stream event. The Stream remains the source for MySQL projection, evidence cards, replay verification, and UI catch-up.

## Wire and projection changes

Existing clients must remain compatible. Additive fields are preferred over changing existing field meaning.

For `AUCTION_SOLD`, keep `winnerId` as the item recipient. Add explicit settlement fields:

```json
{
  "seq": 42,
  "status": "SOLD",
  "settlementMode": "SECOND_PAYER",
  "winnerId": "buyer_a",
  "payerId": "buyer_b",
  "amountCents": "25000",
  "payerAmountCents": "25000",
  "winnerBidCents": "30000",
  "serverTimeMs": 1710000000000
}
```

`amountCents` should continue to mean the amount charged for settlement. In `SECOND_PAYER`, that is the payer amount, not the winner's final bid. `winnerBidCents` records the winning bid for explanation and replay.

The current `orders` table has `buyer_id` and `amount_cents` only. Do not silently store the winner as `buyer_id` if the payer is different. Implementation should either add explicit payer fields or add a separate settlement table before enabling this mode in runtime.

## Evidence and replay requirements

The Replay Verifier must recompute the top two distinct bidders from the Stream and verify that the projected settlement matches the terminal event.

Evidence output should show these fields for `SECOND_PAYER`:

| Field | Meaning |
|---|---|
| `settlementMode` | proves the auction used runner-up-pays rules |
| `winnerId` | item recipient |
| `winnerBidCents` | highest accepted bid |
| `payerId` | charged user |
| `payerAmountCents` | charged amount after cap validation |
| `liabilityCapCents` | frozen maximum liability |
| `closeReason` | `SOLD` or `NO_SECOND_PAYER` |

Hash-chain integrity must cover the full terminal payload. Video remains non-authoritative.

## 100k readiness requirements

This mode must not weaken the current 100k scalability target.

Acceptance gates before enabling runtime behavior:

| Gate | Requirement |
|---|---|
| Lua complexity | bid acceptance stays O(log n) or better with no MySQL/HTTP/LLM calls |
| Fanout | no per-viewer personalized payload on hot broadcast path |
| Replay | verifier rebuilds winner/payer from Stream without Redis state |
| Load | 100k observer scenario records zero sequence gaps and no payer/winner mismatch |
| Race | concurrent same-user rebids cannot occupy both winner and payer slots |
| Backpressure | settlement event remains one broadcast event, not a per-bidder fanout burst |

The 100k load report must include second-payer-specific counters:

```text
secondPayerSettledTotal
secondPayerNoSecondPayerTotal
secondPayerWinnerPayerMismatchTotal
secondPayerLiabilityCapRejectTotal
secondPayerReplayMismatchTotal
```

## Abuse and fairness controls

This mode creates incentives for collusion and griefing. Minimum controls:

| Risk | Control |
|---|---|
| accidental liability | explicit opt-in and visible room badge |
| runaway bids | hard liability cap, no uncapped mode |
| self-dealing | seller account cannot bid; same device/account clusters should be observable |
| collusion | audit log includes winner, payer, bid ladder, and account age signals |
| payment dispute | evidence card must show accepted disclosure version and frozen rules |

Do not enable real-money payment for this mode until product/legal review signs off. It is safe as a demo or points-only game before that review.

## Implementation slices

1. Contract slice: add `settlementMode` to frozen rules and document additive `AUCTION_SOLD` fields.
2. Lua slice: track top two distinct bidders and enforce `secondPayerLiabilityCapCents` atomically.
3. Projection slice: add payer-aware settlement storage instead of overloading `orders.buyer_id`.
4. Replay slice: rebuild winner/payer from Stream and fail on mismatch.
5. UI slice: add opt-in disclosure, room badge, and settlement explanation.
6. Load slice: run the 100k gate with second-payer counters and evidence output.

## Non-goals

This RFC does not change the default auction mode.

This RFC does not replace Redis Lua as the bid adjudicator.

This RFC does not let AI choose winners, payers, caps, or settlement results.

This RFC does not make video authoritative evidence.
