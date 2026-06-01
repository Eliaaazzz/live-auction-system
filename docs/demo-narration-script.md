# Lumen Auction demo narration script

Purpose: a three-minute talk track for the final demo. It pairs each visible
scene with the backend proof signal the presenter can point to. Keep the tone
product-first: transparent auction, known item, verifiable outcome, resilient
operations.

## Timing map

| Time | Scene | Say | Proof cue |
|---:|---|---|---|
| 0:00-0:20 | Seller creates listing | "The seller starts with a known item, confirms the AI-drafted facts, and freezes rules before bidding opens. AI helps draft facts, but it never adjudicates bids." | Product/facts screen; confirmed facts visible |
| 0:20-0:45 | Auction room opens | "Buyers enter the live room over WebSocket. The backend state, not video or UI timing, is authoritative." | Room snapshot shows status and sequence |
| 0:45-1:10 | Competitive bids | "Every bid is adjudicated atomically in Redis Lua. Accepted bids are sequenced, streamed, and fanned out to observers." | Bidder and observer both receive `BID_ACCEPTED` |
| 1:10-1:30 | Anti-snipe extension | "A late bid extends the hammer window. This prevents last-millisecond sniping while keeping the rule frozen before the auction starts." | `AUCTION_EXTENDED`, `extendCount` increases |
| 1:30-1:50 | Hammer close | "The timer worker closes the auction from backend time. The client does not decide the winner." | Terminal `AUCTION_SOLD` event |
| 1:50-2:15 | Evidence card | "The evidence card is not just a receipt. It is derived from the persisted event chain, including the final chain head." | Evidence card `eventsHash` / chain status |
| 2:15-2:35 | Replay verifier | "Replay verification rebuilds state from the durable stream and compares it with MySQL. If it diverges, the verifier reports the first mismatch." | `make verify` output: `consistent` |
| 2:35-2:50 | Load / observability | "The demo path is backed by performance gates: load smoke, latency summaries, sequence-gap counters, and metrics snapshots." | Metrics dashboard or load report |
| 2:50-3:00 | Fallback posture | "If AI or video is unavailable, bidding continues. The core auction path is deterministic and independently verifiable." | AI-offline / fallback note |

## Presenter script

> Lumen Auction is a live auction system for a transparent known-item sale. The
> seller publishes the item, reviews AI-drafted facts, freezes the rules, and
> only then opens the room.
>
> The important design point is authority separation. AI and video improve the
> experience, but they never decide who wins. Bids go through the backend state
> machine, with Redis Lua as the atomic adjudicator.
>
> Here are two buyers bidding in the same room. When a bid is accepted, the
> bidder gets a direct acknowledgement and observers receive the sequenced room
> event. The stream sequence is the source of truth for replay.
>
> A late bid triggers anti-snipe extension. That rule was frozen before the
> auction started, so the seller cannot change it mid-auction.
>
> The timer worker closes the auction. The client UI does not pick the winner;
> it only renders the terminal event produced by the backend.
>
> After close, the evidence card shows the persisted result and the event-chain
> head. The replay verifier can rebuild the auction from the durable event log
> and confirm it matches the stored projection.
>
> Finally, this is not just a happy-path demo. We have load smoke, metrics,
> chaos checks, and AI-offline fallback. If the AI sidecar or video layer goes
> away, the core auction still runs and remains auditable.

## Product emphasis

- Use "AI assists, backend decides" whenever explaining AI or video.
- Use "frozen rules" before showing bids, not after the auction closes.
- Use "evidence chain" and "replay verifier" as separate proof layers.
- Avoid saying AOF everysec is financial-grade durability; say it is the chosen
  demo durability setting and not a notarization guarantee.
- Avoid claiming 100k production proof unless a run artifact exists. Say "the
  harness and runbooks are prepared for the 100k rehearsal" until that evidence
  is captured.

## Backup narration for fallback demo

If the cloud deployment or live video path is unavailable:

> We are switching to the local Docker fallback. This is intentional: the demo
> has a local one-command path so the core auction can be shown without relying
> on cloud access. The fallback still exercises the same backend adjudication,
> evidence chain, replay verifier, and load/chaos gates.

If the AI sidecar is unavailable:

> The AI sidecar is offline in this run. The auction continues because AI is a
> sidecar, not the adjudicator. Seller confirmation and frozen backend rules are
> still enforced.

If load proof is shown as a saved artifact:

> This is the captured load evidence from rehearsal. It includes latency
> summaries, sequence-gap counters, and post-load verifier output. We separate
> server-side latency from client end-to-end RTT so the metric boundary is clear.
