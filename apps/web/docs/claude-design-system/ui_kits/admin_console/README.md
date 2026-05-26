# PC Admin / Seller Console

The PC surface of Lumen Auction. This is where sellers publish items, confirm AI-drafted facts, freeze rules, and operate the live auction; and where admins watch the bid stream and pull the destructive cancel lever.

## What's here

| File | Role |
| --- | --- |
| `index.html` | Click-through prototype with a sidebar nav. Switches between VLM Review, Live Console, Publish, Items & Orders. |
| `styles.css` | Console chrome — left rail, top status strip, console panels, tables. Built on palette B. |
| `components.jsx` | Primitives: `Sidebar`, `TopStatus`, `Stat`, `StatusPill`, `Pipeline5`, `FactCard`, `BidStreamRow`, `IconBtn`. |
| `screens.jsx` | Screens: `VLMReview`, `LiveConsole`, `PublishForm`, `ItemsOrders`, `CancelModal`. |
| `app.jsx` | Sidebar router. Opens the destructive cancel modal over the Live Console. |

## Screens

1. **VLM Fact Review** — source video frame strip, 5 fact cards with AI confidence + seller edit diff, high-risk seller statement field, gate requiring all facts confirmed before SCHEDULED.
2. **Live Console** — stream preview, current price + countdown + Δ + seq, bid stream table, leaderboard, extension count, last 3 rejects, danger zone with the cancel button.
3. **Cancel modal** — 2-step destructive confirm: type the current price, explains AUCTION_CANCELLED push + chain write.
4. **Publish Form** — DRAFT entry form with 5-step pipeline indicator, money-as-cents inputs, anti-snipe settings, start price / increment / reserve / cap.
5. **Items & Orders** — status-filter chips for the full enum (`DRAFT`, `VLM_REVIEW`, `SCHEDULED`, `LIVE`, `SOLD`, `NO_BID`, `CANCELLED`, `ORDER_CREATED`), GMV stat block, sold counts, settlement table.

## Open

Open `index.html`. The sidebar on the left switches screens. The Live Console exposes the danger-zone cancel button that opens the destructive modal.
