# Mobile H5 — Bidder Room

This kit is the Mobile H5 surface of Lumen Auction. It is the centerpiece of the product: the live auction room, the long-press bid wheel, the last-10s anti-snipe tension, the hammer transition, and the evidence card.

## What's here

| File | Role |
| --- | --- |
| `index.html` | Click-through prototype. State stepper on the right walks through 9 key states. |
| `styles.css` | Kit-specific CSS (the dark room chrome, the curtain, the gold halo). Layers on top of `../../colors_and_type.css`. |
| `components.jsx` | Small primitives: `Chip`, `MoneyMono`, `SeqMono`, `LeaderRow`, `Toast`, `ConnectionStrip`, `BidWheel`, `PhoneStatusBar`, `HourglassIcon`. |
| `screens.jsx` | Screen-level compositions: `RoomLive`, `RoomLast10s`, `RoomBidWheel`, `RoomRejected`, `RoomLeading`, `HammerSOLD`, `EvidenceVerified`, `EvidenceBroken`, `Reconnect`. |
| `app.jsx` | The stepper. Cycles states. Triggers the A→B palette curtain. |

## States walked

1. `LIVE 30s` — steady-state, heartbeat pulse, leaderboard, bid ticker, AI auctioneer read-only copy.
2. `LIVE 09s` — last 10s anti-snipe: ripple ring on countdown, color shift, story bid story copy.
3. `BID_WHEEL` — long-press radial price-step wheel; +10× selected.
4. `BID_REJECTED` — `ERR_TOO_LOW`, leaderboard row shake.
5. `YOU_LEAD` — gold halo on user's row, "you are leading" copy.
6. `HAMMER_SOLD` — 0.55s A→B palette curtain, serif hammer price, seq + hash.
7. `EVIDENCE_VERIFIED` — chain verified seal + timeline.
8. `EVIDENCE_BROKEN` — `ERR_HASH_MISMATCH` row inserted, later events untrusted.
9. `RECONNECT` — connection strip in reconnecting → syncing #14922 → #14998 → schema-mismatch → mini-program fallback.

## Open

Open `index.html`. The stepper on the right side lets you advance to each state and trigger the hammer curtain.
