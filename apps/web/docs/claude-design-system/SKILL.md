---
name: lumen-auction-design
description: Use this skill to generate well-branded interfaces and assets for Lumen Auction (Douyin live-auction product), either for production or throwaway prototypes / mocks / decks. Contains essential design guidelines, two-palette color tokens, type, fonts, assets, and React UI kit components for both the Mobile H5 bidder room and the PC seller/admin console.
user-invocable: true
---

Read the `README.md` file within this skill first — it contains product context, content fundamentals, visual foundations, and iconography. Then explore the other files:

- `colors_and_type.css` — all design tokens (two palettes A & B, semantic statuses, type ramp, motion easings, status chips, button primitives). Import this stylesheet on every artifact.
- `assets/` — logos, mark, hammer glyph, chain seal SVGs (verified + broken), hourglass, product placeholder.
- `preview/` — small reference cards for every token system (palette swatches, type specimens, spacing, radii, shadows, motion).
- `ui_kits/mobile_room/` — Mobile H5 bidder room kit. React + Babel components. 9-state click-through covering the full live → hammer → evidence flow.
- `ui_kits/admin_console/` — PC seller / admin kit. Sidebar router across Live Console, VLM Review, Publish, Items & Orders, with the destructive Cancel modal.

When designing:

1. **Two palettes are the single most important rule.** Palette A (Douyin-native, ink + neon red + cyan) for live bidding energy; Palette B (Auctionhouse premium, deep navy + gold + cream) for hammer, evidence, orders. The hammer fall is a 0.55s curtain wipe between them — never blend the two.
2. **Backend is authoritative.** AI-drafted text and the video stream are always non-authoritative. Mark AI surfaces with the cyan `chip--ai` chip ("AI · 仅供参考"). Show real-time `seq`, `Δ`, and connection state on any live surface.
3. **Mono = verifiable.** Money, seq, Δ, hash, lot codes, timestamps must all use JetBrains Mono with `font-variant-numeric: tabular-nums`. The mono treatment is the "this is server truth" signal.
4. **Status language is canonical.** Use the enum verbatim: `DRAFT · VLM_REVIEW · SCHEDULED · LIVE · SOLD · NO_BID · CANCELLED · ORDER_CREATED`. Visible label may be localized; the underlying token stays English.
5. **Copy is two-register.** Palette A copy is fast, present-tense, second-person (你 / you). Palette B copy is measured, declarative, third-person (本场 / this auction). No emoji. No marketing superlatives.
6. **Motion primitives are named.** `heartbeat`, `pulse-ripple`, `hourglass-flip`, `shake-x`, `curtain-wipe`, `gold-pulse-once`. Use them via the keyframes in `colors_and_type.css`.

If creating visual artifacts (slides, mocks, throwaway prototypes), copy assets out of this folder and create static HTML files for the user to view. Import `colors_and_type.css` and apply `.pal-a`, `.pal-b`, or `.pal-b-deep` to your root container — every component primitive (chip, button, card, etc.) reads from those.

If working on production code, treat this folder as the spec. Lift hex values, type stacks, spacing tokens, and motion easings exactly. Components in `ui_kits/*` are simplified visual references — re-implement them properly with React + TypeScript + Tailwind v4 + Zustand + Framer Motion, matching the visual contract.

If the user invokes this skill without other guidance, ask what surface they want to design (mobile bidder room? PC console? a single component? a deck?), ask 4–6 questions about the specific state or flow, and act as an expert designer who outputs HTML artifacts or production-shaped code, depending on the need.
