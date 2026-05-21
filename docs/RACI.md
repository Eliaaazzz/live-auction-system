# RACI

This file records Sprint 1 ownership boundaries for **Lumen Auction：直播实时竞拍系统**. Role labels are stable; B and C names remain TBD until the remaining members confirm.

| Role | Owner | Primary scope | Accountable deliverables |
|---|---|---|---|
| A | @Eliaaazzz | Realtime Engineer | WebSocket Gateway, Bid Engine, Timer Worker, Redis Lua, auction state machine, Replay Verifier, Redis key contract, Stream event schema, bid / hammer consistency, load-test evidence for realtime path |
| B | TBD | Product Engineer | Seller PC admin, user H5 room, auction atmosphere interactions, evidence card UI, mock payment, order/history views, business-facing MySQL schema |
| C | TBD | Infra / AI / QA Engineer | Docker Compose, `.env.example`, CI, k6 / WS Bot load tests, Grafana or metrics dashboard, AI Sidecar, deployment, fault-drill recordings, AI usage materials |

## DB Schema Split

DB ownership is split to avoid duplicate edits to the same schema surface.

| Owner | Tables / flow | Boundary |
|---|---|---|
| A | `auction_events`, `bids`, Redis Stream -> MySQL idempotent replay, `UNIQUE(auction_id, seq)`, `UNIQUE(auction_id, client_bid_id)` | Event-link and replay correctness tables. A must align with Redis Stream schema and Replay Verifier I/O. |
| B | `products`, `auctions`, `auction_rules`, `orders`, `users` | Business, seller, bidder, order, and mock-pay tables. B must align with product/admin/H5 flows and order idempotency. |

MySQL is not the hot bidding path. Redis Lua adjudicates bids, ranking, seq, Stream append, and hammer state; MySQL stores facts, orders, events, and audit material through idempotent projection.

## All-Member Approve Boundary

All members must approve breaking or semantic changes to: WS envelope, Redis key format, Stream event schema, MySQL schema, auction state machine, Lua return structure, evidence card fields, hash chain fields, and AI Sidecar trigger contract.

## Planned Contract Directory

A will establish `proto/`; B and C should reference it after creation.

- `proto/ws-envelope.md`
- `proto/redis-keys.md`
- `proto/openapi.yaml`
- `proto/ai-events.md`
- `proto/db-schema.md`
