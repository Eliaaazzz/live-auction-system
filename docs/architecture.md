# Architecture

Source basis: Issue #2 Architecture RFC v1 §3, with Plan V8 boundaries preserved.

Lumen Auction is organized as four layers. Client surfaces handle seller admin, mobile bidders, and load bots. Edge services terminate REST and WebSocket traffic, enforce auth/rate limits, isolate rooms, and recover clients by `lastSeq`. Core services own all state transitions: Auction Service freezes and starts auctions, Bid Engine calls Redis Lua for bid adjudication, Timer Worker calls Lua for expiry hammer, Order Service creates orders idempotently, Persistence Worker projects Redis Stream into MySQL, and Metrics exposes load-test evidence. Data is split between Redis as the hot authoritative path and MySQL as the fact/audit store.

```text
┌──────────────────────────────────────────────────────────────┐
│ Client Layer                                                  │
│                                                              │
│  Admin PC              Mobile H5             Load Bot         │
│  商品上架/规则/订单     直播间/出价/榜单       1000+ WS 压测     │
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST               │ WebSocket
                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│ Edge Layer                                                    │
│                                                              │
│  Nginx/API Gateway                                            │
│  Auth & Rate Limit                                            │
│  REST BFF                                                     │
│  WebSocket Gateway：room 隔离 / 心跳 / lastSeq 恢复             │
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST command/query │ bid command
                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│ Core Layer                                                    │
│                                                              │
│  Auction Service       Bid Engine          Timer Worker       │
│  开拍/取消/规则校验      place_bid.lua       close_auction.lua  │
│                                                              │
│  Order Service         Persistence Worker   Metrics API        │
│  幂等订单生成            Stream → MySQL      压测指标输出        │
└───────────────┬────────────────────┬─────────────────────────┘
                │ atomic write       │ stream consume
                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│ Data Layer                                                    │
│                                                              │
│  Redis：实时唯一热源                                          │
│  - auction:{id}:state                                         │
│  - auction:{id}:leaderboard                                   │
│  - auction:{id}:events Stream                                 │
│  - auction:{id}:dedupe:{userId}                               │
│  - auction:active                                             │
│                                                              │
│  MySQL：事实库                                                │
│  - users / products / auctions / auction_rules                │
│  - bids / orders / auction_events / ai_usage_logs             │
└──────────────────────────────────────────────────────────────┘
```

Edge rules:

- WebSocket Gateway manages connection lifecycle, rooms, heartbeat, `lastSeq` recovery, and broadcast. It never mutates auction truth directly.
- REST BFF exposes product, auction, rule, order, snapshot, mock-pay, and evidence views. REST commands that affect auction state call core services.

Core rules:

- Bid Engine is the only bid acceptance entry. `place_bid.lua` validates state, dedupe, amount, cap, anti-snipe, `seq`, Stream append, and Pub/Sub publish atomically.
- Timer Worker is the only expiry adjudicator. It scans `auction:active`, then `close_auction.lua` re-checks Redis TIME before closing.
- Order Service is idempotent; `orders.auction_id` is unique.
- Replay Verifier replays Stream and compares Redis snapshot and MySQL projection for `consistent`, `mismatch_at_seq=X`, or `hash_break_at_seq=Y`.

Data rules:

- Redis is the live hot path and uses AOF everysec; the system does not promise financial-grade durability.
- MySQL stores products, rules, auctions, bids, orders, events, and AI usage logs for history and materials.
- Redis Pub/Sub is only a wake-up/fanout channel. Catchup and persistence use Redis Stream.
- AI Sidecar is non-adjudicating: VLM facts require seller confirmation, LLM auctioneer text reads confirmed facts and server events only.
