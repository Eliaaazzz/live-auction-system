# Demo rehearsal go/no-go checklist

Purpose: make the 2026-06-09 fallback rehearsal for issue #87 auditable without
turning it into another feature branch. This checklist is for the operator who
runs the public demo or local Docker fallback on rehearsal day.

## Scope

This checklist covers the remaining #87 execution lane:

- public deployment preflight
- local Docker fallback rehearsal
- evidence bundle capture
- backup recording readiness
- narration and claim-boundary checks

It does not change the demo path, CI, Redis Lua adjudication, Redis Stream event
log, Timer Worker close behavior, Replay Verifier, or any payment/order logic.

## Inputs

Prepare these before starting the rehearsal:

- a fresh deployment target or local Docker stack
- demo seller and bidder accounts appropriate for the target environment
- a terminal ready to run the demo evidence-pack helper
- the 3-minute narration script
- backup recording software with microphone and screen capture tested
- a place to store the rehearsal evidence directory and backup video files

Do not paste secrets, `.env` values, API keys, cloud tokens, cookies, or stream
keys into the rehearsal notes.

## Go/no-go gates

| Gate | Required evidence | Go condition | No-go condition |
|---|---|---|---|
| Health | `/healthz` or equivalent preflight output | service responds successfully | service unavailable or wrong target |
| Metrics | `/metrics` snapshot | metrics endpoint responds and can be archived | metrics missing or malformed |
| Auction path | asserted demo path or saved evidence pack | publish, bid, anti-snipe, hammer, evidence card, and replay are all covered | any required scene has no live or saved proof |
| Replay Verifier | verifier output | `consistent` for the demo auction | mismatch, missing auction, or unverifiable output |
| Evidence chain | evidence verification output | no hash break reported | `hash_break` or missing chain head |
| AI fallback | AI-offline path or narration fallback | bidding continues when AI is unavailable | demo depends on AI to adjudicate bids |
| Video fallback | live stream or simulated sheen | video is clearly display-only and fallback is acceptable | video failure blocks bidding or hides the auction path |
| Load claim | saved load evidence or current run | only artifact-backed concurrency claims are spoken | unsupported 100k claim or mixed server/client latency claim |
| Recording | backup video/audio | recording started and recoverable | no usable backup recording |

## Rehearsal sequence

1. Run deploy or local-stack preflight and save the output.
2. Start backup recording before opening the seller/admin view.
3. Walk the 3-minute narration once at normal speed.
4. Capture the evidence pack for the same auction used in the walkthrough.
5. Verify replay and evidence-chain outputs from the captured artifacts.
6. Run the AI-offline or fallback narration branch if the live AI path is not available.
7. Confirm the video path is display-only: bidding must remain usable if the stream is absent or broken.
8. Record final go/no-go status and list any scene that requires saved footage instead of live execution.

## Claim boundaries to say out loud

- Redis Lua is the bid adjudicator.
- Redis Stream is the durable event log for replay.
- Timer Worker closes expired auctions.
- AI is advisory and non-authoritative.
- Video is display-only and non-authoritative.
- AOF everysec is not a financial-grade durability guarantee.
- 100k concurrency is not claimed unless a distributed run passes the evidence gate and its artifacts are available.

## Final rehearsal note template

```text
Date:
Operator:
Target: public deploy / local Docker / saved footage
Auction id:
Evidence dir:
Backup recording path:

Go/no-go: GO / NO-GO

Failed gates:
- none

Fallbacks used:
- none

Claims allowed in demo:
- 10k verified if current evidence is available
- 100k only if gate-passing distributed artifacts are available

Residual risks:
- none
```
