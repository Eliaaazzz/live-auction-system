# Roadmap

V9 (issue #1) supersedes this with T0-T10 trunk steps; this file remains as Sprint baseline.

Source basis: Plan V8 §7 and RFC v1 §12. The table keeps V8’s 4 Sprint / 20-day structure and folds RFC’s six phases into day-level work. Internal freeze is 2026-06-08; public deadline remains 2026-06-10.

| Day | Date | Sprint | RFC phase | Focus | Exit evidence |
|---|---:|---|---|---|---|
| 1 | 05-19 | Sprint 1 | Day 1-2 architecture freeze | Freeze WebSocket envelope, Redis keys, OpenAPI, AI events, state machine. | Five contracts reviewed. |
| 2 | 05-20 | Sprint 1 | Day 1-2 architecture freeze | Repo skeleton, Docker MySQL + Redis, health check, WS echo/room join. | Local services boot. |
| 3 | 05-21 | Sprint 1 | Day 3-6 P0 loop | Product create/list and auction/rule draft path. | Seller can create draft auction. |
| 4 | 05-22 | Sprint 1 | Day 3-6 P0 loop | Seller confirm VLM facts, freeze rules, start auction. | Rules immutable after start. |
| 5 | 05-23 | Sprint 1 | Day 3-6 P0 loop | One dummy bid roundtrip through WS and room broadcast. | End-to-end skeleton works. |
| 6 | 05-24 | Sprint 2 | Day 3-6 P0 loop | `place_bid.lua` status, amount, cap, dedupe, `seq`. | Concurrent bid unit tests begin. |
| 7 | 05-25 | Sprint 2 | Day 7-10 consistency | `close_auction.lua`, Timer Worker, `auction:active`. | Hammer no longer depends on next bid. |
| 8 | 05-26 | Sprint 2 | Day 7-10 consistency | Anti-snipe, Stream ID `<seq>-0`, Pub/Sub fanout. | `seq gap = 0` in test. |
| 9 | 05-27 | Sprint 2 | Day 7-10 consistency | Persistence Worker, MySQL idempotent orders/events. | Unique constraints reject duplicates. |
| 10 | 05-28 | Sprint 2 | Day 7-10 consistency | Room UI price/countdown/ranking/evidence v0. | 50-user auction closes correctly. |
| 11 | 05-29 | Sprint 3 | Day 11-14 experience | Multi gateway fanout and reconnect catchup. | `ROOM_JOIN + lastSeq` replay works. |
| 12 | 05-30 | Sprint 3 | Day 11-14 experience | Snapshot fallback for trimmed/large gaps. | Catchup 200 events < 1s target tested. |
| 13 | 05-31 | Sprint 3 | Day 11-14 experience | Evidence hash chain UI and Replay Verifier v1. | Verifier reports `consistent`. |
| 14 | 06-01 | Sprint 3 | Day 11-14 experience | LLM auctioneer triggers: open, jump, cold 30s, hammer. | AI offline badge preserves core auction. |
| 15 | 06-02 | Sprint 3 | Day 15-18 perf | P0 load run: 500 connected + 50 active. | ack/broadcast/seq metrics captured. |
| 16 | 06-03 | Sprint 4 | Day 15-18 perf | Tune ack p95 < 80ms and broadcast p95 < 150ms. | Metrics dashboard screenshot. |
| 17 | 06-04 | Sprint 4 | Day 15-18 perf | Hammer p95 < 500ms, catchup 200 events < 1s. | Report table filled. |
| 18 | 06-05 | Sprint 4 | Day 15-18 perf | Fault drills: MySQL, WS, Timer, AI, Redis. | Five short clips or rehearsal notes. |
| 19 | 06-06 | Sprint 4 | Day 19-21 materials | Public preview + local Docker fallback + backup video. | Demo script rehearsed. |
| 20 | 06-08 | Sprint 4 | Day 19-21 materials | Final internal freeze: README, report, video, dashboard, verifier. | 3-minute demo path complete. |

Stretch remains visible but not blocking: 1k connected + 100 active bidders, ack p99 < 100ms, broadcast p99 < 300ms.
