# Demo Submission Pack · 成果演示提交包

This document is the freeze-time checklist for the official demo submission. It turns the scattered tracker items into reviewer-facing copy, a video script, and evidence boundaries that the team can reuse directly in the final form.

Related tracker: #234.

## 1. Final project identity

Use one consistent name everywhere: the submission form, video title, README, and demo landing page.

- Project name: **直播竞拍全栈系统（Lumen Auction）**
- One-line pitch: **A real-time live-auction system with atomic bid adjudication, anti-sniping, verifiable evidence replay, AI-assisted seller tools, and 10k-class WebSocket load evidence.**
- Repository: `https://github.com/Eliaaazzz/live-auction-system`

Before submission, replace this section’s placeholders with the exact official team name and final member list.

| Member | School / Major | Primary responsibility | One-sentence contribution highlight |
|---|---|---|---|
| TODO | TODO | Frontend / UX / buyer flow | TODO |
| TODO | TODO | Backend / bidding core / persistence | TODO |
| TODO | TODO | AI / data / deployment / testing | TODO |

## 2. Core feature list

Keep the public submission concise. Five features are enough; each one should map to something visible in the demo or verifiable in the repository.

1. **Real-time bidding with anti-sniping** — buyers join a live room, place bids, receive authoritative bid results, and see auction time extend near the end.
2. **Strategy-based auction modes** — the backend supports multiple auction rule variants while preserving a single adjudication and replay boundary.
3. **AI-assisted seller and demo flow** — AI sidecar features support richer product/demo interaction without becoming the source of truth for settlement.
4. **Evidence chain and Replay Verifier** — settlement can be independently checked from recorded events instead of trusted only from UI state.
5. **10k-class WebSocket load evidence** — the team has repeatable load tools, metrics dashboards, and runbooks for high-concurrency proof.

## 3. End-to-end user flow

Use this wording as the baseline submission description:

1. A seller publishes an auction item with a start price, increment rule, and optional media/AI-assisted content.
2. A buyer opens the live room, reads the participation rules, and joins the auction.
3. During the auction, the buyer places bids through the UI; the server remains the only authority that accepts or rejects bids.
4. Accepted bids update the live room through WebSocket fanout, while anti-sniping logic extends the deadline when needed.
5. When the auction ends, the system emits a terminal result and persists the evidence needed for later verification.
6. Reviewers can inspect the evidence card or run Replay Verifier to confirm that the final winner and price match the event history.

## 4. Three-minute demo video script

Target length: 3 minutes. Record a fallback video even if the online demo link works, because judges may open the submission from a restricted network.

| Time | Segment | What to show | Narration goal |
|---|---|---|---|
| 0:00–0:20 | Problem and positioning | Landing page / room entry | “Live auction needs low-latency bidding, trusted settlement, and high-concurrency delivery.” |
| 0:20–1:10 | Buyer path | Join gate, rules, bid chips, custom bid, accepted/rejected result | Show that bidding is simple for users but server-authoritative. |
| 1:10–1:45 | Auction close | Anti-snipe extension, hammer result, winner display | Show the core auction lifecycle, not just a static UI. |
| 1:45–2:20 | Trust path | Evidence card / Replay Verifier output | Explain that the result is replayable and auditable. |
| 2:20–2:45 | Engineering proof | Metrics dashboard / loadtest report / runbook | Show 10k-class concurrency evidence with clear claim boundaries. |
| 2:45–3:00 | Wrap-up | Architecture diagram or final room state | Summarize: real-time, verifiable, scalable, demo-ready. |

## 5. Demo link and fallback assets

Before final submission, collect these links in one place.

- Online demo URL: TODO
- Experience account or login method: TODO
- Fallback video URL: TODO
- Architecture diagram: TODO
- Main README / run instructions: TODO
- Performance report / runbook: TODO
- Replay Verifier evidence: TODO

Final smoke check:

- Open the demo URL in a private browser window.
- Confirm the room loads without local-only state.
- Confirm login or demo token instructions are visible.
- Confirm the fallback video is public or accessible to judges.
- Confirm README commands do not require secrets that are not documented.

## 6. Reviewer-friendly architecture summary

Use this high-level architecture in slides, README, and video narration. Do not present it as a source-code dependency graph.

```text
Buyer / Seller Web UI
        |
        v
Lumen Gateway: REST + WebSocket
        |
        +--> Redis Lua bid adjudication
        |        |
        |        +--> Redis Stream room events
        |                 |
        |                 +--> WebSocket fanout / ROOM_STATE_PATCH
        |
        +--> MySQL persistence + evidence records
        |
        +--> AI sidecar for assisted seller/demo features
        |
        +--> Metrics + loadtest tooling + Replay Verifier
```

Core message: **Redis/Lua decides bids atomically; WebSocket delivers room state; persisted evidence and Replay Verifier make the final result auditable.**

## 7. Load-test claim boundaries

Keep the performance claims precise. Do not merge different topologies into one sentence.

| Claim type | What it can prove | What it must not claim |
|---|---|---|
| Loopback / single host | Process-level capacity and hot-path correctness | Real public-network capacity |
| Private IP / in-VPC worker | Real network path inside the deployment VPC | Public Internet reachability |
| Public EIP from same host/VPC | Mostly tests NAT hairpin/self-dial behavior | Application capacity, if connection setup fails |
| External public worker / public LB | Strongest public demo evidence | Internal-only topology conclusions |

Recommended wording:

> The system has repeatable load tooling and evidence for 10k-class WebSocket auctions. We separate loopback, private-network, and public-network results so the performance claim remains technically honest.

Avoid this wording:

> Public 10k is fully proven.

Only say that after the external public-worker / public-LB run has passed with `activeConns >= 10000`, latency budgets green, `seqGapCount=0`, `backpressureForceClose=0`, and Replay Verifier consistent.

## 8. Submission readiness checklist

### Must-have before deadline

- [ ] Final project name matches the submission form.
- [ ] Team name and three member rows are filled.
- [ ] Online demo link works from a clean browser.
- [ ] Fallback video link is accessible.
- [ ] README contains setup, environment, run, and verification instructions.
- [ ] Architecture diagram is included or linked.
- [ ] Core feature list is concise and matches the demo.
- [ ] Load-test evidence uses honest topology wording.
- [ ] Replay/evidence verification path is shown.

### Nice-to-have if time remains

- [ ] One-page “trusted auction loop” diagram: bid → Lua adjudication → Stream → fanout → evidence → replay.
- [ ] Short backup GIF for the buyer flow.
- [ ] Screenshot of the metrics dashboard during a passing run.
- [ ] Freeze commit SHA and final branch noted in the submission.

## 9. Five-minute stranger test

Before submitting, ask one person who has not followed the project to spend five minutes with the material. They should be able to answer:

1. What problem does the system solve?
2. How does a user complete an auction?
3. Why is the final winner/price trustworthy?
4. Where is the code and how can it run?
5. What concurrency evidence exists, and what exactly does it prove?

If any answer is unclear, fix the README/video/script before polishing lower-priority details.
