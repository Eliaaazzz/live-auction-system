# Diagram inspection report

Generated and checked on 2026-05-23 after reading the official spec PDF, GitHub
issues `#1`-`#17`, and pull requests `#12`, `#13`, `#16`, `#18`, `#19`, and
`#20`.

## Upload candidates

Use the `docs/architecture/v4/*.png` files for GitHub issue or PR comments, and
keep the paired `*.svg` files as editable source where present.

| Diagram | Status | Inspection note |
| --- | --- | --- |
| `01-system-architecture` | accepted | Replaced the initial Mermaid render with the checked v3 SVG layout, retitled to v4, and shortened the bottom rule so text does not clip. |
| `02-bid-hot-path` | accepted | Replaced the wide Mermaid sequence render with the checked v3 SVG layout; ACK path, Redis Lua decision point, ordered fanout, persistence, and idempotency fences are readable. |
| `03-auction-state-machine` | accepted | Replaced the sprawling Mermaid render with the checked v3 SVG layout; canonical states are `DRAFT`, `SCHEDULED`, `LIVE`, `SOLD`, `NO_BID`, `CANCELLED`, and `ORDER_CREATED`. |
| `04-reconnect-catchup` | accepted | Mermaid render is readable; reconnect uses `lastSeq`, snapshot plus replay, and stale sequence filtering. |
| `05-timer-evidence` | accepted | Mermaid render is wide but readable; hammer close, terminal fanout, persistence, evidence generation, and replay verification are represented. |
| `06-mysql-er` | accepted | Mermaid ER render is tall but readable; users, products, auctions, frozen rules, bids, events, orders, and AI usage logs are represented. |
| `07-ai-sidecar` | accepted | Mermaid render is readable; AI remains advisory and is blocked from adjudicating bids, winners, auction close, order creation, payment, or frozen-rule mutation. |
| `08-ownership-evidence` | accepted | Mermaid render is tall but readable; delivery surfaces map to scoring evidence and runtime ownership. |

## GPT image 2 drafts

The raw GPT image 2 outputs are saved in `docs/architecture/gpt-image-2-drafts/`.
They are retained for visual reference only.

| Draft | Status | Inspection note |
| --- | --- | --- |
| `01-system-architecture-draft.png` | draft only | Visually useful, but final upload uses the checked v4 SVG/PNG architecture diagram. |
| `02-bid-hot-path-draft.png` | draft only | Visually useful, but final upload uses the checked v4 SVG/PNG hot-path diagram. |
| `03-state-machine-draft-rejected.png` | rejected | Cancel/terminal paths were not reliable enough for GitHub upload. |
| `04-reconnect-catchup-draft.png` | draft only | Visually useful, but final upload uses the checked v4 reconnect/catchup diagram. |
| `05-timer-evidence-draft.png` | draft only | Some evidence/replay arrows were ambiguous; final upload uses the checked v4 timer/evidence diagram. |
| `06-er-model-draft.png` | draft only | Visually useful, but final upload uses the checked v4 ER diagram. |
| `07-ai-sidecar-draft.png` | draft only | Guardrail wording was too restrictive/inaccurate in places; final upload uses the checked v4 AI-sidecar diagram. |
| `08-ownership-evidence-draft.png` | draft only | Visually useful, but final upload uses the checked v4 ownership/evidence diagram. |
