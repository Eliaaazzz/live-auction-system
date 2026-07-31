# Decisions Log

Public project decisions are recorded here so implementation issues and documents do not drift. Project name: **Lumen Auction: Real-Time Live-Streaming Auction System**.

| Date | Q# | Topic | Decision | Decided by | Affected issue/file |
|---|---|---|---|---|---|
| 2026-05-21 | Q1 | Deadline | External D-day is 2026-06-10; internal hard deadline is 2026-06-08; 2026-06-09 is bugfix, data, recording, and rehearsal only. | @Eliaaazzz | #11, `docs/charter.md` |
| 2026-05-21 | Q2 | Project name | Use **Lumen Auction: Real-Time Live-Streaming Auction System**. Repo, README, architecture diagrams, and PPT title use `Lumen Auction`; the challenge mapping remains `Real-Time Auction Master`. | @Eliaaazzz | #11, public materials |
| 2026-05-21 | Q3 | A/B/C ownership | @Eliaaazzz takes A / Realtime Engineer. B and C remain TBD; DB ownership is split by event-link tables vs business tables. *Pending @PDGGK and third member confirm.* | @Eliaaazzz | #11, `docs/RACI.md` |
| 2026-05-21 | Q4 | P0 highlights | P0 keeps Replay Verifier, hash chain, 500 connected + 50 active stable load proof, and five fault-drill short videos. 1000 connected + 100 active is Stretch. | @Eliaaazzz | #1, #11, `docs/charter.md` |
| 2026-05-21 | Q5 | Time commitment | Each member must state daily available hours, unavailable days, strongest area, and avoid area before Sprint 1 issue sizing. *@PDGGK pending confirm.* | @Eliaaazzz | #11 |
| 2026-05-21 | Q6 | Third member onboarding | Third member should self-introduce with technical background, availability, B/C preference, and ability to own deploy, load test, recording, or docs. *Third member pending confirm.* | @Eliaaazzz | #11, `docs/RACI.md` |
| 2026-05-21 | Q7 | Doubao API key | Secrets never enter git, issue, PR, commit, log, or screenshot. Repo keeps only `.env.example`; local and deploy credentials stay in private channels / GitHub Secrets. AI Sidecar must degrade to mock, timeout fallback, and never block bidding. *@PDGGK pending confirm.* | @Eliaaazzz | #11, `.env.example` |
| 2026-05-21 | Q8 | Load target | P0 is 500 connected + 50 active. Stretch is 1000 connected + 100 active. Reports must include ack p95, broadcast p95, hammer p95, catchup 200 events, seq gap = 0, success/reject rates, reconnect catchup, bottlenecks, and recovery after drills. | @Eliaaazzz | #1, #8, #11 |
| 2026-05-21 | Q9 | Demo form | Demo priority is public deployment, then local Docker fallback, then pre-recorded video insurance. Fallback must be rehearsed before submission. | @Eliaaazzz | #9, #11 |
| 2026-05-22 | Q-Stack | Implementation stack | Backend = **Go** (Gin/Fiber + Gorilla WebSocket); Frontend = **React + TypeScript**; DB = **MySQL 8 + Redis**. | @Eliaaazzz | #11, `docs/architecture.md`, `docs/roadmap.md` |

## Single Sources Of Truth

| Area | Decision |
|---|---|
| DB | Use **MySQL 8 + Redis**. Redis Lua owns the hot auction path; MySQL stores facts, orders, audit events, AI logs, and idempotent projections. Postgres / `pg_writer` wording is historical drift. |
| State machine | `docs/state-machine.md` is the canonical state contract. `AUCTION_EXTENDED` is an event, not a state. UI labels may map to simplified words, but backend/protocol keep one state vocabulary. |
| Contract files | Phase 1: contracts live in `docs/` (this PR). Phase 2 (Sprint 1, A line owner) materializes them to `proto/` per Issue #14. Closed design issues #3-#9 are references, not active implementation entry points. |
| P0 / Stretch | P0 = Replay Verifier + hash chain + 500/50 stable proof + five fault-drill videos. 1000/100 is Stretch and must not displace the core evidence chain. |

V8 engineering boundaries remain frozen: Redis hash tag `{<aid>}`, Lua validate-before-write, Stream ID `<seq>-0`, Redis TIME with `>=`, Hash dedupe returning original ack, single `seq`, AOF everysec with explicit pause on Redis failure, WS bufferedAmount thresholds 1MB/4MB, and video as non-authoritative.

## Sprint 1 Appendix

Sprint 1 targets single-source closure, skeleton run, and dummy bid roundtrip.

- A1: RFC #2 / README / #11 stack wording closure: MySQL + Redis, state machine, V8 boundaries.
- A2: Phase 1 contracts live in `docs/` (this PR); Phase 2 (Sprint 1, A line owner) materializes them to `proto/` per Issue #14.
- A3: `docs/state-machine.md` canonical contract; `AUCTION_EXTENDED` is event only.
- A4: `place_bid.lua` / `close_auction.lua` align to Redis TIME, `>=`, Hash dedupe, single `seq`, `<seq>-0`.
- A5: Dummy bid roundtrip: WS -> Bid Engine -> Redis Lua -> Stream/PubSub -> broadcast.
- B6: Seller admin skeleton and auction-start console.
- B7: User H5 bidding page skeleton and WS event rendering.
- B8: Evidence card UI skeleton with hash fields.
- B9: MySQL migration skeleton; business tables first, event-link tables aligned with A.
- C10: Docker Compose / `.env.example` / local one-command startup with MySQL 8, Redis, backend, frontend.
- C11: Load-test skeleton that connects WS, sends dummy bids, and records ack/broadcast metrics.
- C12: AI Sidecar mock and timeout fallback.
- C13: Demo fallback checklist for public deployment, local fallback, and recording paths.
