# Lumen Auction Design System

**Lumen Auction · 直播实时竞拍系统** — a Douyin E‑commerce AI Full‑Stack live auction product for transparent, known‑item auctions. Sellers publish items, confirm AI‑drafted facts, freeze auction rules, and run real‑time bidding. The backend (Redis Lua + Redis Stream + Timer Worker + Replay Verifier) is the single source of truth for price, winner, and timing. The AI sidecar and the video stream are **non‑authoritative** read‑only aids.

This design system defines the next iteration we will build — not a restyle of the current `web/` skeleton, but the visual language and component set for a production v1.

---

## Sources

You should explore these to do a more thorough job:

- **Tracking issues:** #41 (front-end design language parent), #42 (PC seller/admin), #43 (Mobile H5 bidder room).
- **GitHub:** <https://github.com/Eliaaazzz/live-auction-system>
  The T6 front-end implementation and design brief live under `apps/web/`; legacy static prototypes remain at `web/index.html`, `web/admin.html`, and `web/room.html`. Current backend work lives under `apps/lumen/` and `apps/ai-sidecar/`.
- **Reference PDF:** `Lumen Auction · 直播竞拍系统 · 打印版.pdf` — high‑fidelity static visual spec covering all 12 anchor screens (Mobile Room LIVE, last‑10s anti‑snipe, long‑press wheel, leading/rejected, Hammer/SOLD, Evidence card, PC VLM review, Live Console, dangerous cancel, publish form, items/orders, mini‑program/reconnect states).
- **Canonical product docs:** `docs/charter.md`, `docs/architecture.md`, `docs/decisions.md`, `proto/ws-envelope.md`, and `proto/ai-events.md`.

---

## Index — what's in this folder

| Path | Purpose |
| --- | --- |
| `README.md` | This file. Product context, content + visual foundations, iconography. |
| `SKILL.md` | Agent‑skill manifest for AI design/code assistants. |
| `colors_and_type.css` | All design tokens — palette A (Douyin), palette B (Auctionhouse), semantic colors, type ramp, spacing, radii, shadows, motion. |
| `assets/` | Logos, icon SVGs, illustrative imagery. |
| `preview/` | Small HTML reference cards for colors, type, spacing, components, and brand. |
| `ui_kits/mobile_room/` | Mobile H5 bidder room UI kit + click‑through prototype. |
| `ui_kits/admin_console/` | PC seller / admin UI kit (VLM review, Live Console, publish, items/orders). |

---

## Product surfaces this system must cover

**Mobile H5 — bidder.** Live auction room is the centerpiece. The system must express:
- Steady‑state bidding (`LIVE 30s+`) with heartbeat pulse, real‑time bid ticker, leader strip, your‑position gap.
- Anti‑snipe tension at `T‑10s`: hourglass, pulse ripple, color temperature shift, +10× story bids.
- Long‑press radial price‑step wheel (`+1× / +2× / +5× / +10×`, release to bid).
- Leading halo (gold), bid‑rejected shake + `ERR_TOO_LOW` toast.
- Hammer / `SOLD` transition: 0.55s A→B palette switch, gold curtain, serif display of hammer price + winner + seq.
- Evidence card with `CHAIN VERIFIED` timeline and `CHAIN BROKEN` warning.
- Connection states: `RECONNECTING`, `SYNCING #14922 → #14998`, `SCHEMA MISMATCH`, mini‑program fallback.

**PC — seller & admin.** Workflows must feel like a trading console, not a SaaS dashboard:
- VLM fact review (5 fact cards, confidence, diff, high‑risk seller statement, gate before auction).
- Publish form (5‑step pipeline `DRAFT → VLM_REVIEW → SCHEDULED → LIVE → SOLD/NO_BID/CANCELLED`).
- Live Console (stream preview, bid stream table, leaderboard, last‑3 rejects, danger zone cancel).
- Cancel 2‑step destructive modal (current price input, AUCTION_CANCELLED broadcast, chain write).
- Items & Orders (status filters, GMV, sold counts, settlement table).

---

## CONTENT FUNDAMENTALS

**Voice.** Two registers, switched by palette.
- **Palette A (Douyin‑native, live room):** fast, low‑ceremony, present‑tense, second‑person. Verbs lead. No hedging.
  - 出价 +10  ·  你正在领先  ·  剩余 00:09  ·  延时 +5s
  - PLACE BID  ·  YOU LEAD  ·  EXTENDED +5s  ·  RECONNECTING…
- **Palette B (Auctionhouse premium, hammer + evidence):** measured, declarative, third‑person. Reads like a notarial receipt.
  - 已成交  ·  落槌价 ¥12,800.00  ·  得标人 u_8842 · 哈希链已验证
  - SOLD  ·  Hammer Price ¥12,800.00  ·  Winner u_8842  ·  Chain Verified

**Casing.**
- All caps reserved for status chips (`LIVE`, `EXTENDED`, `SOLD`, `NO_BID`, `CANCELLED`, `DRAFT`, `VLM_REVIEW`, `SCHEDULED`, `ORDER_CREATED`), and for monospaced technical reads (`seq #14998`, `Δ 42ms`).
- Sentence case for everything else, both Chinese and English. No Title Case body copy.

**Person.**
- Bidder UI speaks *to* the user (你 / you).
- Seller / admin UI speaks *about* the auction (本场 / this auction). Destructive verbs are explicit (`取消本场拍卖` / `Cancel this auction`) — never euphemistic.

**Numbers, money, time, IDs.**
- Money: always shown in mono (`JetBrains Mono`), with currency glyph + 2 decimals, grouping commas. Stored as cents strings server‑side; rendered with `Intl.NumberFormat`. Examples: `¥12,800.00`, `$1,250.50`.
- Sequence: `#14998` (mono, `#` prefix, no leading zeros).
- Server‑time delta: `Δ 42ms` (mono, Greek delta + ms). Color shifts amber if > 250ms, red if > 1000ms or reconnecting.
- Time: `mm:ss` for countdowns, never `0:9` — always `00:09`.
- Hashes: monospace, truncated middle: `0x7af3…b21c`. Click to copy.

**Status language is canonical and untranslated in code paths.** Do not localize enum values. The visible label may be translated, but the underlying token (`SOLD`, `NO_BID`, `CANCELLED`) must appear verbatim in any technical surface (chips, hover tooltips, evidence rows).

**What we never say.**
- No emoji. The brand uses iconography or palette shifts instead. (One exception: 🔨 in the SOLD transition is *allowed*, never required — prefer the hammer SVG.)
- No "Oops!" "Whoops!" "Uh‑oh!" — failures are stated plainly: `ERR_TOO_LOW · 出价低于当前价`.
- No marketing superlatives ("amazing deal", "incredible"). The auction is the spectacle; copy describes it.
- No promises the backend cannot keep. AI‑drafted copy is always marked `AI · 仅供参考` (AI · reference only).

**Vibe.** Cold‑lit auction floor meets late‑night livestream. Two temperatures, one product. Every screen should answer: *what is true right now, and how do I know?*

---

## VISUAL FOUNDATIONS

### Two‑palette system

The single biggest design move is the **A↔B palette switch**. The product lives in palette A (Douyin‑native, dark, neon) during the live auction; it transitions to palette B (Auctionhouse premium, deep navy + gold + cream) at hammer fall and stays there for evidence, orders, settlement, and any "the record stands" surface.

- **Palette A — Douyin‑native, live energy.**
  `--douyin-ink #171a28` · `--douyin-ink-soft #1f2333` · `--douyin-red #FE2C55` · `--douyin-red-deep #cb203f` · `--douyin-cyan #25F4EE` · `--ink-text #f5f5f7`.
  Backgrounds are near‑black with a 1–2% blue cast; red is the action color, cyan is reserved for AI‑sidecar tags and your‑own‑bid highlights only.

- **Palette B — Auctionhouse premium, trust + record.**
  `--solemn-deep #0A1F44` · `--solemn-deep-soft #142a55` · `--solemn-gold #C9A961` · `--solemn-gold-soft #dcbf7f` · `--solemn-cream #F5EDDD` · `--bridge-rose-gold #b88a5a`.
  Backgrounds are deep navy or cream; gold is reserved for hammer, evidence, and seal moments.

- **Semantic tokens** (palette‑independent): `--sem-live #FE2C55` · `--sem-extended #FFB020` · `--sem-sold #C9A961` · `--sem-no-bid #6b7280` · `--sem-cancelled #9aa0b4` · `--sem-rejected #ff4d70`.

### Typography

- **UI sans (CJK + Latin):** PingFang SC → HarmonyOS Sans SC → Noto Sans SC stack. The system fonts are preferred when available on device; Noto Sans SC ships as the web fallback.
- **Premium serif (display only):** Noto Serif SC / Source Han Serif SC. Used at hammer, evidence headers, and seller‑confirmed item titles. Never for body, never under 24px.
- **Monospace:** JetBrains Mono. Used for *every* number that comes from the backend — money, seq, Δ, hash, lot codes, timestamps. The mono treatment IS the "this is verifiable data" signal.

**Display scale (Mobile H5):** `40 · 32 · 24 · 18 · 16 · 14 · 12`.
**Display scale (PC console):** `56 · 40 · 28 · 22 · 18 · 16 · 14 · 13 · 12`.
**Hammer display:** 96px serif on mobile, 160px serif on PC. This is the only place type goes huge.

### Spacing & layout

- 4px base. Token ramp: `2 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 80`.
- Mobile: 16px gutters, 12px row spacing in lists, 8px component padding.
- PC: 12‑column grid at 1440 with 24px gutters; console panels snap to 320 / 400 / 720 / full‑width.
- **Fixed elements:** mobile bottom action bar (`PLACE BID`), mobile sticky top (price + countdown), PC left nav (72px collapsed / 240px expanded), PC top status strip (server time + Δ + connection).

### Radii

- `--r-xs 4px` chips, badges.
- `--r-sm 8px` inputs, small cards.
- `--r-md 12px` standard cards, modals.
- `--r-lg 20px` mobile sheets, hero cards.
- `--r-pill 9999px` action buttons, bid wheel.
- Evidence card uses a **soft‑square** corner (`--r-sm`) — never pill, never extra‑rounded; it should read as a document.

### Cards

- **Palette A card:** `--douyin-ink-soft` fill, 1px inner border `rgba(255,255,255,0.06)`, no shadow, optional 1px top accent `--douyin-red` for "live" cards.
- **Palette B card:** `--solemn-cream` fill, 1px border `rgba(10,31,68,0.12)`, outer shadow `0 1px 0 rgba(10,31,68,0.04), 0 8px 24px -12px rgba(10,31,68,0.18)`. Header optionally uses a gold hairline divider.
- **Evidence card:** B card + serif header + monospaced timeline rows + a single gold seal mark top‑right when verified, red broken‑chain mark when not.

### Shadow system

- Mobile A has effectively no shadow — the dark surface differentiates by alpha, not elevation.
- PC B uses two elevations: `e1` (cards) and `e2` (modals, danger zone). No `e3+`.
- `--shadow-glow-live` (red, 0 0 24px rgba(254,44,85,0.45)) is a *state*, not an elevation; only on leading halos and live indicator pulses.
- `--shadow-glow-gold` (gold, 0 0 32px rgba(201,169,97,0.35)) is for the hammer fall curtain and chain‑verified seal.

### Borders & dividers

- Default border in A: `1px solid rgba(255,255,255,0.08)`.
- Default border in B: `1px solid rgba(10,31,68,0.12)`.
- Section dividers in B use a 1px gold hairline at 40% alpha — never a heavy rule.

### Transparency & blur

- Mobile sticky top bar uses `backdrop-filter: blur(24px) saturate(160%)` over palette A ink at 78% alpha. This is the *only* place we use blur on mobile.
- PC modal scrim is solid `rgba(10,31,68,0.72)`, no blur — modal content must read as paper, not glass.
- Toasts (rejection, extension) use opaque pills, never glass.

### Backgrounds

- No gradients in the base UI. The only gradients permitted are:
  - **Bottom protection gradient** on mobile, behind the bid action bar — palette‑ink → transparent, 96px tall.
  - **Hammer curtain** during the 0.55s A→B transition — a gold sheet that wipes top‑to‑bottom with a 0.18 opacity grain.
- No stock photography. Item imagery is the seller's own product photo, presented full‑bleed and unfiltered.

### Motion

All motion is on a 4‑step easing system:

| Token | Curve | Use |
| --- | --- | --- |
| `--ease-snap` | `cubic-bezier(.2,.8,.2,1)` | UI taps, chip on/off |
| `--ease-pulse` | `cubic-bezier(.4,0,.6,1)` | Heartbeat, ripple, breathing |
| `--ease-curtain` | `cubic-bezier(.7,0,.2,1)` | A→B palette switch, hammer wipe |
| `--ease-overshoot` | `cubic-bezier(.34,1.56,.64,1)` | Bid wheel reveal, leading halo land |

Named primitives:
- **Heartbeat** — 1.4s pulse on the LIVE dot, scale 1 → 1.08 → 1, opacity ring 0.6 → 0.
- **Pulse ripple** — last‑10s, a concentric red ring expanding from the countdown, 0.9s, 3 stacked at 300ms delay.
- **Hourglass tick** — last‑10s, 1s SVG hourglass flip per second, no easing (linear).
- **Rejection shake** — 280ms, ±6px translateX, 3 cycles, easing `--ease-snap`.
- **Radial bid wheel** — 220ms reveal with `--ease-overshoot` on scale + opacity; segments fan out staggered 20ms.
- **Hammer 0.55s palette switch** — `--ease-curtain`, gold sheet wipes top→bottom, type cross‑fades from sans→serif, background interpolates ink→deep over the same window.
- **Chain‑verified glow** — gold seal pulses once (1.2s), then stills. Never loops.
- **Chain‑broken warning** — single 600ms red flash with `ERR_HASH_MISMATCH` mono row insert above the broken event. No loop, no shake.

### Interaction states

- **Hover** (PC only): palette A → background `rgba(255,255,255,0.04)` overlay; palette B → background `rgba(10,31,68,0.04)`. Bordered controls add `border-color: --douyin-red` or `--solemn-gold` respectively.
- **Press (active):** transform `scale(0.97)`, 80ms `--ease-snap`. Buttons darken 8%.
- **Focus:** 2px outline in `--douyin-cyan` (A) or `--solemn-gold` (B), 2px offset. Never remove focus outline.
- **Disabled:** 40% opacity, no pointer events. No grey overlay.
- **Loading:** mono‑tick spinner (rotating square dot) — never spinning circle. Color follows palette.

### Imagery temperature

- Product imagery: shown unfiltered. The seller's color choices are part of the auction record.
- AI‑sampled frames in VLM review are presented at 60% brightness with a cyan 1px border to mark them as machine‑sourced and non‑authoritative.

---

## ICONOGRAPHY

The system uses a single icon set across both palettes: **Lucide** (1.5px stroke, 24px nominal, rounded joins). Lucide is loaded via CDN (`https://unpkg.com/lucide-static/icons/`) and inlined as SVG when bundled.

> **Substitution note:** PingFang SC, HarmonyOS Sans SC, and Source Han Serif SC are not freely distributable web fonts. The CSS imports **Noto Sans SC**, **Noto Serif SC**, and **JetBrains Mono** from Google Fonts as web fallbacks. System fonts are preferred when present on the user's device. If licensed CJK fonts are added later, update `--font-sans` and `--font-serif` in `colors_and_type.css`.

**Brand‑specific glyphs we own** (in `assets/`):
- `logo-lumen.svg` — wordmark, two‑tone (ink + gold). Serif "Lumen" + sans "Auction".
- `mark-lumen.svg` — square mark, gavel‑in‑aperture.
- `icon-hammer.svg` — the SOLD glyph. Used in serif header beside hammer price.
- `icon-seal-verified.svg` / `icon-seal-broken.svg` — chain seal marks for evidence card.
- `icon-hourglass.svg` — last‑10s anti‑snipe glyph (animated via SMIL fallback).

**Lucide icons used in the product:**
- `gavel`, `radio`, `wifi-off`, `refresh-cw`, `chevrons-up`, `triangle-alert`, `shield-check`, `link-2`, `link-2-off`, `clock`, `users`, `flame`, `eye`, `check-circle-2`, `x-circle`, `circle-dollar-sign`, `file-text`, `play`, `pause`, `more-horizontal`.

**Emoji:** none, anywhere. Status uses colored chips. The hammer at SOLD is the SVG glyph, never 🔨.

**Unicode characters used as glyphs:** `Δ` (delta) for server‑time skew, `#` for seq, `¥ / $` for currency. These are typeset in JetBrains Mono in‑line with the numbers, not as iconography.

---

## Caveats / known gaps

- Fonts use Google Fonts fallbacks for the three CJK system fonts. Replace the font stacks with licensed files if the team adds them later.
- Real product photography is not included. The kits use a single neutral placeholder.
- The Hammer palette‑switch and Evidence chain‑broken animations are demonstrated in the mobile kit; production should validate against a real Replay Verifier event stream.
