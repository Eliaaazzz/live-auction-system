# Project Charter

Lumen Auction: Real-Time Live-Streaming Auction System turns the challenge brief's "Real-Time Auction Master" into a credible live auction kernel: a known-item auction flow where sellers publish goods, confirm AI-drafted facts, freeze rules, run real-time bidding, and close with auditable order/evidence material.

The PDF scoring split is the planning lens: 50% technical implementation and engineering completeness, 25% technical depth and innovation, 15% AI use and landing effect, and 10% project materials. The project therefore cannot be only a pretty room UI or only an infrastructure demo. It must show a full auction loop, real-time correctness, AI usage that is traceable, and clear demo/report material.

Scope is layered by V8:

- P0: product CRUD, seller-confirmed facts, frozen auction rules, live room, WebSocket bid loop, Redis Lua adjudication, Redis Stream event log, Timer Worker hammer, evidence card, Replay Verifier, hash chain, 500 connected + 50 active bidder proof, and five fault-drill short videos.
- P1 / Stretch: 1k connected + 100 active report, risk signals, seller-accepted dynamic rule suggestions, OTP login, TTS proof of concept, physical socket split.
- P2: GBDT pricing model, owner handoff, real HLS, multi-region/CRDT, native app, real payment/logistics.

Deadline alignment: outward-facing planning uses 2026-06-10. The internal deadline is 2026-06-08 for core code, demo flow, and load-test report freeze; 2026-06-09 is bugfix, data fill, recording, and rehearsal; 2026-06-10 is final submission only.
