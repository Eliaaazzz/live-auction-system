# Diagrams

Render with Mermaid CLI, for example:

```bash
mmdc -i docs/diagrams/01-system-context.mmd -o docs/diagrams/01-system-context.svg
```

| File | Purpose |
|---|---|
| `01-system-context.mmd` | C4-style context: Client, Edge, Core, and Data layers. |
| `02-state-machine.mmd` | Full auction state machine with anti-snipe as event, not state. |
| `03-bid-sequence.mmd` | Bid chain from H5 through WS, Bid Engine, Lua, Stream, Pub/Sub, broadcast, and MySQL persistence. |
| `04-reconnect-sequence.mmd` | Reconnect catchup with `ROOM_JOIN`, `lastSeq`, Stream replay, and snapshot fallback. |
| `05-timer-hammer.mmd` | Timer Worker hammer flow from `auction:active` scan to terminal broadcast/order/evidence. |
| `06-er-diagram.mmd` | MySQL entities for users, products, auctions, rules, bids, orders, events, and AI usage logs. |
| `07-team-rbac.mmd` | A/B/C ownership and runtime role permissions. |
