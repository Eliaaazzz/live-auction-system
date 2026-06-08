# Lumen Auction Final Demo Deck Draft

> Purpose: source copy for the final PDF / presentation submission. Keep the PDF itself concise (10–12 pages) and link detailed evidence to `docs/` reports instead of flooding slides with logs.
>
> Claim discipline: this deck should be accurate to the latest evidence. We can claim real public 10k clean pass; we must describe 20k / ~50k bids/s as a boundary-finding failure, not as a pass.

---

## Slide 1 — Cover / Project Identity

**Lumen Auction — AI-Enhanced Live Auction System**

A real-time full-stack live-auction platform for high-value single-item sales, combining AI-assisted listing, atomic bidding, verifiable evidence, multiple auction modes, and 10k-class live-room engineering.

**Team**

| Member | School / Major | Role |
|---|---|---|
| TBD | TBD | TBD |
| TBD | TBD | TBD |
| TBD | TBD | TBD |

**Links**

- Online demo: `<final URL>`
- Demo video: `<final URL>`
- Repository: `https://github.com/Eliaaazzz/live-auction-system`
- Final commit: `<freeze SHA>`

---

## Slide 2 — Problem / Scenario

Live commerce auctions are exciting only if the system stays fast, fair, and explainable under pressure.

**User scenario**

- A seller lists a high-value single item in a live room.
- Many buyers join, watch the live feed, and compete in the final seconds.
- The system must accept bids with low latency, prevent unfair race outcomes, and produce a verifiable result.

**Core challenges**

1. Real-time concurrency: thousands of viewers receive synchronized price/state updates.
2. Correct adjudication: only one authoritative bid result is allowed at each price point.
3. Trust: buyers need an evidence trail, not just a UI message saying “sold”.
4. AI safety: AI can assist presentation, but must not decide price or winner.

---

## Slide 3 — End-to-End Demo Flow

**Flow**

1. Seller creates a product and confirms AI-generated facts.
2. Seller configures auction rules and freezes the auction.
3. Buyer enters the mobile live room and accepts participation terms.
4. Buyer places bids; backend adjudicates atomically.
5. Anti-snipe extension protects the final seconds.
6. Timer Worker hammers the auction.
7. Evidence card and Replay Verifier prove the outcome.
8. Optional simulated payment/order flow completes the story.

**Demo script target**

- 0:00–0:20 project intro
- 0:20–0:50 seller listing + AI facts
- 0:50–1:30 buyer room + bids + anti-snipe
- 1:30–1:55 hammer + evidence card
- 1:55–2:25 mode cutaway
- 2:25–2:50 10k performance evidence + boundary
- 2:50–3:00 summary

---

## Slide 4 — System Architecture

**Architecture blocks**

- Web frontend: Buyer Room, Seller Admin, Evidence Card
- Lumen backend: REST API, WebSocket Gateway, Bid Engine, Timer Worker, Replay Verifier
- Redis: Lua adjudication, hot auction state, leaderboard, Stream event log, Pub/Sub hints
- MySQL: persisted auction projection, orders, evidence rows
- AI Sidecar: VLM facts draft and commentary only
- Observability: `/metrics`, `/version`, wsload, Locust, Replay Verifier

**Two key paths**

- **Decision path:** Bid → Redis Lua → Redis Stream → MySQL/evidence projection
- **Display path:** Stream/PubSub → WebSocket fanout / `ROOM_STATE_PATCH` → buyer UI

**Important boundary**

AI/video/commentary are display/assistive features. Redis Lua + Stream remain the authority for price, winner, and event history.

---

## Slide 5 — Core Features

1. **Real-time live auction room**
   - Current price, countdown, bidder feedback, final-10s effects, anti-snipe extension.

2. **Atomic bid adjudication**
   - Redis Lua ensures bid ordering and winner logic stay consistent under concurrency.

3. **Verifiable evidence chain**
   - Redis Stream + MySQL projection + Replay Verifier give a dispute-auditable record.

4. **AI auctioneer sidecar**
   - AI assists listing facts and live commentary while staying non-authoritative.

5. **Multiple auction modes**
   - English, Sudden Death, Sealed, Vickrey, Hybrid Reveal, ALL_PAY virtual coins, Prequalify → Formal auction.

---

## Slide 6 — Engineering Challenge 1: Correct Bidding Under Concurrency

**Challenge**

Concurrent bids must not create double winners, duplicated outcomes, sequence gaps, or room-state divergence.

**Solution**

- Redis Lua is the single authoritative adjudicator.
- `clientBidId` dedupe preserves idempotency.
- Money is represented as strings to avoid precision loss.
- Redis Stream is the durable event log.
- MySQL is a projection, not the hot-path authority.

**Evidence**

- Replay Verifier checks Stream/MySQL/snapshot consistency.
- `seqGapCount == 0` is a core correctness gate.
- CI includes hidden review-discovered gates such as runner-up/Vickrey fixture checks and WS coalescing race tests.

---

## Slide 7 — Engineering Challenge 2: 10k Live-Room Fanout

**Challenge**

At 10k viewers, broadcasting every bid to every connection can overload queues, memory, and GC.

**Solution**

- Bidder-visible ACKs are prioritized separately from public fanout.
- Large rooms use `ROOM_STATE_PATCH` projections rather than full per-bid public events.
- Write coalescing reduces TCP write amplification.
- `wsload` provides a dedicated high-scale WebSocket harness.
- `wsdash.py` and `/metrics` provide live readiness gates.

**Evidence boundary**

| Scenario | Result | Meaning |
|---|---:|---|
| Real public Tier-2 10k | PASS | Public path reached clean 10k with correctness signals green; evidence tracked in #233 |
| Loopback/private-IP 10k | PASS | App process and private path can hold 10k |
| 20k / ~50k bids/s | FAIL / boundary found | Single-gateway memory/GC capacity cliff found; evidence tracked in #233 |

Do not claim 20k as a pass. Use it as a boundary discovery that led to admission control and observability hardening.

---

## Slide 8 — Engineering Challenge 3: Recovery, Degradation, Observability

**Challenge**

A live demo cannot depend on guessing whether failures are caused by code, network topology, or host resources.

**Solution**

- `/version` exposes build identity and schema version to prevent stale deploy evidence.
- Deploy preflight checks `/version`, `/healthz`, `/metrics`, and current-schema WS smoke.
- Metrics reset creates clean run windows.
- Admission control converts overload from process crash to bounded 503 shedding.
- Runtime gauges expose heap/goroutine growth.
- pprof is loopback-only and opt-in.

**Outcome**

The project can explain not just what passed, but what failed, why it failed, and how the next iteration reduces risk.

---

## Slide 9 — AI Capability and Safety Boundary

**AI-assisted parts**

- Product fact draft from image/text input.
- Live-room commentary and auctioneer copy.
- Seller-facing assistance, not final authority.

**Non-authoritative boundary**

AI does not decide:

- whether a bid is accepted;
- who wins;
- final price;
- evidence-chain validity;
- payment/order state.

**Failure handling**

If AI sidecar is unavailable, the room shows an offline auctioneer state while bidding continues. This preserves the trading path and avoids AI as a single point of failure.

---

## Slide 10 — Innovation Highlights

1. **Pluggable auction modes**
   - English, Sealed, Vickrey, Hybrid Reveal, ALL_PAY virtual coins, Prequalify → Formal auction.

2. **Evidence-first auction design**
   - Every outcome can be replayed and checked rather than trusted as a frontend display.

3. **Large-room adaptive fanout direction**
   - Direct ACKs remain low-latency while public viewers receive compressed room-state projections.

4. **Performance evidence with honest boundaries**
   - 10k public pass is reported; 20k failure is treated as a capacity boundary and engineering input.

Compliance note for ALL_PAY: virtual coins only; no real payment, no gambling, no logistics commitment.

---

## Slide 11 — Submission Links and Artifacts

**Required submission links**

- Online Demo: `<final URL>`
- Demo Video: `<final URL>`
- GitHub: `https://github.com/Eliaaazzz/live-auction-system`
- README: `README.md`
- Demo runbook: `docs/demo-runbook.md`
- Performance evidence: #233 (Tier-2 public 10k pass + 20k boundary issue) and `docs/runbooks/beijing-tier1-10k-demo.md`
- Architecture / protocols:
  - `proto/ws-envelope.md`
  - `proto/redis-keys.md`
  - `proto/db-schema.md`

**Recommended attached material**

- Architecture diagram PNG
- 3-minute video script
- Team roles sheet
- Performance summary
- AI usage sheet

---

## Slide 12 — Current Status, Boundary, Next Step

**Completed**

- End-to-end live auction flow
- AI sidecar integration
- Atomic Redis Lua bid path
- Evidence card and Replay Verifier
- Multi-mode auction demos
- Real public 10k clean pass

**Known boundary**

- A 20k connection / ~50k bids/s stress run exposed a single-gateway memory/GC cliff.
- Correctness did not break, but the gateway process restarted under overload.

**Next step**

- Atomic WS admission gate
- Memory/GC hardening
- Multi-gateway room affinity
- Adaptive large-room fanout controller
- Confidence-scored reserve advisor

**Closing line**

Lumen Auction shows a credible path from AI-assisted live commerce to verifiable, high-concurrency auction infrastructure: fast enough for a live room, strict enough for dispute evidence, and honest about the next scaling boundary.

---

# Claim Wording Bank

## Safe

> We verified a real public 10k-concurrent live-auction run with clean correctness signals: no sequence gap, no backpressure force-close, and Replay Verifier consistency.

> A 20k / ~50k bids/s stress run exposed the single-gateway memory/GC boundary, which led to admission control and observability hardening.

## Avoid

> The system stably supports 20k concurrent users / 50k bids per second in production.

## Better

> 20k / ~50k bids/s is a boundary discovery experiment, not a pass claim. It identifies the next scaling layer: admission control, GC/memory tuning, and multi-gateway routing.
