---
editor_options: 
  markdown: 
    wrap: 72
---

# Lumen Auction — Design System Brief

> **Read this cold.** This document is self-contained — you don't need
> any chat history, GitHub issue, or repo state to use it. It exists so
> any designer or design-capable LLM (e.g. Claude with
> `/frontend-design`) can deliver visual proposals for Lumen Auction
> without further onboarding.

------------------------------------------------------------------------

## §0 What we want from this document

A **visual design pass** on the screens listed in §14. Specifically: 1.
Static mockups (high fidelity) for the 6 anchor screens. 2.
Color/type/motion specimens that align with the **A+B accent rule** in
§5. 3. Treatment recommendations for the 8 "hero moments" listed in §10.
4. Anti-slop self-check: every visual element you propose must satisfy
§11.

Constraints binding the work are in §2–§13. **Read §11 before
sketching** — it's the disqualifier list.

------------------------------------------------------------------------

## §1 Project context

**Lumen Auction** is a live-streaming auction system entered into
Bytedance's Douyin E-commerce AI Full Stack 2026 challenge. It is
**not** an abstract auction app and **not** a marketplace clone. It is a
credible auction kernel: high-value single items, real-time WebSocket
bidding, atomic Redis Lua adjudication, anti-snipe extensions, monotonic
event sequence guarantees, hash-chained evidence, and Replay Verifier
provenance.

**Audience for the design**: - **Judges**: Bytedance engineers +
product. They have seen many livestream commerce demos; the design's job
is to make them *believe* this is engineered, not skinned. - **End
users**: Mobile-first Chinese consumers familiar with Douyin live
commerce patterns (上车, 心动值, 福袋, 抢单). -
**Sellers/broadcasters**: Power users running auctions from a desktop
control surface.

**Judging rubric weights** (these are the only goals that matter): \|
Weight \| Category \| What designs are scored on \| \|---\|---\|---\| \|
50% \| 技术实现与工程完整度 \| Does the UI surface real engineering
invariants (clock skew, seqguard, hash chain, reconnect, anti-snipe)? \|
\| 25% \| 技术深度与创新性 \| Is the real-time / bidding / hammer /
catchup loop intelligently visualized? \| \| 15% \| AI 使用与落地效果 \|
VLM facts confirmation flow + LLM auctioneer text — visible, semantic,
never blocking \| \| 10% \| 项目材料完整度 \| Polish, demo video,
screenshots \|

**Critical**: The product gets a higher score for making backend
invariants *visible* than for being prettier. **Decoration that doesn't
anchor an invariant or rubric category is wasted budget.**

**Timeline**: - Today: 2026-05-25 - Internal freeze: 2026-06-08 (14
days) - Public D-day: 2026-06-10

------------------------------------------------------------------------

## §2 Surfaces & scope

| Surface | Status | Owner-side | Primary device |
|------------------|------------------|------------------|------------------|
| **Mobile H5 — Room** | P0 | Buyer | iPhone 13/14 viewport (390×844), iPhone SE (375×667) lower bound |
| **Mobile H5 — Evidence** | P0 | Buyer (post-hammer) | Same |
| **PC Admin — VLM facts confirmation** | P0 (hero of admin) | Seller | Desktop 1440px+ |
| **PC Admin — Live console** | P0 | Seller (broadcaster) | Desktop 1440px+ |
| **PC Admin — Auction publish form** | P0 | Seller | Desktop 1440px+ |
| **PC Admin — Cancel-with-confirmation flow** | P0 | Seller | Desktop 1440px+ |
| **PC Admin — Order & product management** | P1 | Seller | Desktop 1440px+ |
| **Mini-program** | OPEN DECISION → C | — | Stub-only landing ("请在抖音 App 打开") |

**Out of scope**: native iOS/Android apps; payment flow; logistics; user
authentication beyond dev-login.

------------------------------------------------------------------------

## §3 Backend contract — what the UI must render

Every visible element in the auction room is driven by one of these wire
events. The design must surface them legibly; the design must not
contradict or hide them.

### §3.1 Auction state machine (canonical 7 states — never invent an 8th)

```         
DRAFT  →  SCHEDULED  →  LIVE  →  { SOLD | NO_BID | CANCELLED }  →  ORDER_CREATED
```

`AUCTION_EXTENDED` is an **event, not a state**. UI renders it as a
badge ("延时 +30s · 第 K 次反狙击") while status remains LIVE.

Terminal states: SOLD, NO_BID, CANCELLED, ORDER_CREATED. These reject
further bids.

### §3.2 WebSocket events (server → client)

| Event | Carries | UI behavior |
|------------------------|------------------------|------------------------|
| `ROOM_SNAPSHOT` | full state on join | Initialize all UI |
| `BID_ACCEPTED` | `seq · userId · displayName · amountCents · endAtMs · status` | Animate price; update countdown end; if self → "you're leading" flash; if was-self → "overtaken" banner |
| `BID_REJECTED` | `code` | Shake bid button + toast with semantic copy |
| `AUCTION_EXTENDED` | `seq · endAtMs · extendCount` | Light-sweep on countdown; increment extend badge |
| `AUCTION_SOLD` | `seq · winnerId · amountCents` | Hammer overlay; flip to solemn palette (see §5) |
| `AUCTION_NO_BID` | `seq · status` | Static "本场无人出价" gray-scale end |
| `AUCTION_CANCELLED` | `seq · status` | "已取消" red stamp overlay |
| `PONG` | — | Heartbeat ack |

Every envelope carries `serverTimeMs` — used to maintain a client-server
clock offset (P4).

### §3.3 WebSocket events (client → server)

| Event | Payload | When |
|------------------------|------------------------|------------------------|
| `ROOM_JOIN` | `{ auctionId, lastSeq? }` | On connect or pull-to-refresh resync |
| `BID_PLACE` | `{ clientBidId, amountCents }` | On bid button tap |
| `PING` | — | 15s heartbeat |

### §3.4 REST endpoints

| Endpoint | Returns | UI use |
|------------------------|------------------------|------------------------|
| `POST /api/dev-login` | `{ userId, token, nickname }` | Acquire session token |
| `GET /api/auctions/:id` | Snapshot fallback | Pre-LIVE preview |
| `GET /api/auctions/:id/leaderboard?n=10` | top-N by max accepted bid | Leaderboard component |
| `GET /api/auctions/:id/evidence` | hash-chain timeline + chain head + optional order | Evidence screen |
| `POST /api/auctions` | `{ auctionId }` | Admin: publish |
| `POST /api/auctions/:id/freeze` | facts-confirmed gate | Admin: enter SCHEDULED |
| `POST /api/auctions/:id/start` | `{ endAtMs }` | Admin: go LIVE |
| `POST /api/auctions/:id/cancel` | terminal | Admin: cancel (with 2-step confirm UI) |

### §3.5 Hard data invariants

-   **Money is `string` everywhere**. Backend serializes cents as
    decimal string. UI must never store as `Number`. Display formatting
    is via `formatCentsCNY()` (existing helper).
-   **Time is `endAtMs` (server clock)**. Compute remaining as
    `endAtMs - (clientNow + serverClockOffsetMs)`. Never compare
    `Date.now()` directly.
-   **`seq` is monotonic per auction**. Client maintains a `seqguard`
    that drops duplicates and detects gaps. Visible gaps trigger catchup
    UI.
-   **`extendCount` is the trust signal**. Anti-snipe is a product
    differentiator; the count *must* be visible.

------------------------------------------------------------------------

## §4 Design principles (P1–P10)

These are **invariants**. Any visual proposal must satisfy all ten. If a
treatment violates one, redesign.

| \# | Principle | What it means visually |
|------------------------|------------------------|------------------------|
| **P1** | Money is rendered as Decimal string, not parsed number | Use `formatCentsCNY(cents: string)`. Never display a JS-number-parsed value. Component receives strings. |
| **P2** | UI labels map to the canonical 7-state set | No "Extended" state, no "Cooling" state, no "Hammered" state. `AUCTION_EXTENDED` is a badge. |
| **P3** | AI components must degrade gracefully | AI bubble must have a first-class offline state. AI outage cannot block bidding, countdown, or leaderboard. Default copy: "拍卖师暂离 · 出价不受影响" |
| **P4** | Countdown uses `serverClockOffsetMs` self-correction | Maintain offset from `serverTimeMs - clientReceiveTimeMs`. Update on every envelope. Drift \>500ms surfaces a Δ warning. |
| **P5** | `extendCount` is always visible during LIVE | Anti-snipe is the product's trust differentiator. The number must be on screen, not hidden in a menu. |
| **P6** | Evidence card surfaces hash-chain credibility | Display `prev_hash → event_hash` chain, ≥8 hex chars per link, click to expand full hash. Don't paint over it with illustration. |
| **P7** | WebSocket lifecycle is visible | Reconnecting → thin top bar. Catchup gap → "正在同步 #N→#M". Schema mismatch → instructive error. Silent reconnect is forbidden. |
| **P8** | WS message handler ≤5ms; animation on compositor | 60fps motion via CSS/WAAPI (transform/opacity); React state updates only at semantic boundaries (≤1Hz for ticks). Broadcast SLO p95 \<150ms is sacred. |
| **P9** | Reduced-motion + frame-budget auto-degrade | Honor `prefers-reduced-motion`. Runtime FPS dropout → `body.surface-calm` removes decorative animation; semantic motion (state transitions) keeps a single-frame fade. |
| **P10** | Anti-slop: every visual element has a semantic reason | Gradients, glow, blur, particles appear only on emotional events (overtake, leading, hammer, extend). No decorative chrome. No generic-AI patterns. (See §11.) |

------------------------------------------------------------------------

## §5 Visual direction — the A+B accent rule

This is the single most important design decision: a **two-palette
system** that *switches based on auction state*.

### §5.1 The rule

```         
default surface             = A · Douyin-Native    (LIVE / SCHEDULED / DRAFT / NO_BID / CANCELLED rooms)
bridge surface (transient)  = bridge palette       (~1.0s hammer transition only)
solemn surface (gated)      = B · AuctionHouse Premium  (SOLD / ORDER_CREATED / Evidence screen)
```

The room renders in palette A during the action. At the **hammer
moment** (status becomes SOLD) the room does NOT hard-flip; it
**crossfades through the bridge palette** for ~1.0s — a gold veil falls
from the top (`@keyframes lumen-veil-drop`), the underlying room blurs
out (`lumen-room-blur-out`), and a warm bridge layer
(`lumen-veil-bridge-fade`) fades in before the solemn surface settles.
Result: the user experiences "this is being recorded" without the
visual whiplash a raw A→B flip caused in earlier prototypes. The
Evidence screen is *always* solemn regardless of how the user entered
it.

The bridge palette is a deliberate addition (post-prototype feedback);
without it, B's `#0A1F44` deep navy reads as a different brand from
A's `#161823` near-black. The bridge tones — warm bronze
`#b88a5a` rose-gold + plum `#2a1c3a` / `#1f1d3a` — are mixed warm/cool
tones that read as a sunset transition. They never appear as the
default room surface; only during the ~1.0s hammer crossfade and as
sparing accent lifts where A and B touch (medal halos, gold hairlines).

**Why this works**: - Douyin energy carries the live tension (D2/D5
strengths). - Auction-house gravitas validates the moment of conclusion
(D4 strength, D1 lift). - The flip itself is a designed moment — it
tells the user "this is over, this is recorded, this is real."

**Why we did not pick pure A** (D5 satura, D4 weakness): pure Douyin
slides into "抽奖感" (lottery-game feel). Auctions can't feel like
gacha.

**Why we did not pick pure B** (D4 satura, D5 weakness): pure
auction-house is sleepy for a livestream context and the judges work at
Douyin.

### §5.2 What A and B look like

**A — Douyin-Native**: - Mood: current, hot, mobile-native,
in-the-moment - Hero color: Douyin red `#FE2C55` on near-black
`#161823` - Accent: Douyin cyan `#25F4EE` for sparing semantic
highlights (online presence, gain feedback) - Typography: PingFang SC /
抖音 Sans body; tabular-mono for numerics - Motion register: snappy
springs, immediate, sub-200ms responsiveness, micro-interactions per tap

**B — AuctionHouse Premium**: - Mood: ceremonial, recorded, dignified,
ledger-like - Hero color: champagne gold `#C9A961` on deep navy
`#0A1F44` - Accent: cream `#F5EDDD` for body text on dark surfaces -
Typography: Noto Serif SC / Playfair Display display; tabular-mono for
hashes and numerics - Motion register: slow, intentional, single-curve
eases, no springs

### §5.3 When mid-palette is allowed

Tabular-mono (`JetBrains Mono` / `IBM Plex Mono`) numerics — for price,
seq, hashes, extendCount, leaderboard amounts — are
**palette-agnostic**. They stay in mono in both A and B. This is the
"trading floor precision" sliver of style C (#41 §4.3) borrowed for
credibility, kept narrow per Elia review.

### §5.4 Bridge palette — the smoothing layer

| Token              | Hex       | Use                                                              |
|--------------------|-----------|------------------------------------------------------------------|
| `bridge-plum-1`    | `#2a1c3a` | Hammer transition — surge fade-from layer                        |
| `bridge-plum-2`    | `#1f1d3a` | Hammer transition — intermediate between A's ink and B's deep    |
| `bridge-twilight`  | `#1a1d3a` | Hammer transition — late-stage shade closest to solemn-deep      |
| `bridge-rose-gold` | `#b88a5a` | Cross-palette accent lift between red and gold (rank-1 medals)   |
| `x-gold-thin`      | `rgba(201,169,97,.42)` | 1px gold hairlines that appear in both A and B (cross-palette continuity) |
| `x-rank-1-glow`    | `rgba(220,191,127,.6)`  | TOP-1 medal halo, works in either palette                  |

These are **not** general-purpose palette tokens — using them as the
default surface for any screen is a violation of §5.1. They exist for
exactly two purposes:

1. **The hammer transition.** Used by `lumen-veil-drop`,
   `lumen-veil-bridge-fade`, `lumen-room-blur-out`,
   `lumen-hammer-reveal-up`. The full transition lasts ~1.05s; bridge
   tokens are only visible during that window.
2. **Cross-palette anchors.** Hairlines and rank halos that need to
   read identically in A (Douyin) and B (solemn) without recoloring.
   `--x-gold-thin` and `--x-rank-1-glow` solve the "TOP-1 medal looks
   different in the Room vs the Evidence card" problem.

If a designer or component author reaches for a bridge token outside
these two contexts, redesign — the right fix is almost always a
state-semantic token (§6.1).

------------------------------------------------------------------------

## §6 Design tokens

These are **already implemented** at `src/styles.css` (CSS custom
properties on `:root`). Treat them as canonical. If a proposal needs a
token that doesn't exist, name it explicitly so we extend the system.

### §6.1 Color

#### A · Douyin-Native palette

| Token              | Hex       | Purpose                               |
|--------------------|-----------|---------------------------------------|
| `douyin-ink`       | `#171a28` | Page background (slightly bluer than pure Douyin black — bridges visually toward B's deep navy) |
| `douyin-ink-soft`  | `#1f2333` | Cards, surfaces over ink              |
| `douyin-ink-card`  | `#262a3c` | Elevated cards, leaderboard rows      |
| `douyin-ink-text`  | `#f5f5f7` | Body text on ink                      |
| `douyin-ink-muted` | `#9aa0b4` | Metadata, captions                    |
| `douyin-ink-dim`   | `#6b7186` | Tertiary text, disabled states        |
| `douyin-red`       | `#FE2C55` | LIVE badge, primary CTA, bid button   |
| `douyin-red-soft`  | `#ff4d70` | Hover/focus on red                    |
| `douyin-red-deep`  | `#cb203f` | Pressed red, rank-3 halo              |
| `douyin-cyan`      | `#25F4EE` | Gain indicators, "syncing" affordance |
| `douyin-cyan-soft` | `#5af7f1` | Highlight states                      |

#### B · AuctionHouse Premium palette

| Token              | Hex       | Purpose                                                 |
|--------------------|-----------|---------------------------------------------------------|
| `solemn-deep`      | `#0A1F44` | Page background                                         |
| `solemn-deep-soft` | `#142a55` | Cards over deep                                         |
| `solemn-deep-card` | `#16306b` | Elevated cards, hash-chain rows                         |
| `solemn-gold`      | `#C9A961` | Hero numerals, chain-verified badges, accent strokes    |
| `solemn-gold-soft` | `#dcbf7f` | Subtle gold for SOLD secondary states                   |
| `solemn-gold-deep` | `#a08543` | Pressed gold, deep gold borders                         |
| `solemn-cream`     | `#F5EDDD` | Body text on deep                                       |
| `solemn-cream-dim` | `rgba(245,237,221,0.62)` | Secondary body text on deep                |
| `solemn-ink`       | `#101010` | Text on solemn-gold buttons                             |

#### Bridge palette — A↔B smoothing (see §5.4)

| Token              | Hex       | Use                                                              |
|--------------------|-----------|------------------------------------------------------------------|
| `bridge-plum-1`    | `#2a1c3a` | Hammer transition — surge fade-from layer                        |
| `bridge-plum-2`    | `#1f1d3a` | Hammer transition — intermediate shade                           |
| `bridge-twilight`  | `#1a1d3a` | Hammer transition — late-stage shade closest to solemn-deep      |
| `bridge-rose-gold` | `#b88a5a` | Cross-palette accent lift (rank-1 medals across A and B)         |
| `x-gold-thin`      | `rgba(201,169,97,.42)` | Cross-palette gold hairlines (1px separators in both A and B) |
| `x-rank-1-glow`    | `rgba(220,191,127,.6)`  | TOP-1 medal halo, palette-agnostic                      |

#### State-semantic (palette-agnostic)

| Token             | Hex       | Use                                         |
|-------------------|-----------|---------------------------------------------|
| `state-live`      | `#FE2C55` | LIVE status, warning countdown              |
| `state-extended`  | `#FFB020` | AUCTION_EXTENDED badge, clock drift warning |
| `state-sold`      | `#C9A961` | SOLD badge, hammer reveal                   |
| `state-no-bid`    | `#6b7280` | NO_BID gray finale                          |
| `state-cancelled` | `#9aa0b4` | CANCELLED stamp                             |
| `state-rejected`  | `#ff4d70` | BID_REJECTED toast, hash-break flag         |

### §6.2 Typography

| Stack | Tokens | When |
|------------------------|------------------------|------------------------|
| **Sans (default)** | `"PingFang SC", "HarmonyOS Sans SC", system-ui, sans-serif` | Body, UI, buttons in palette A |
| **Serif** | `"Noto Serif SC", "Source Han Serif SC", Georgia, serif` | Hero numerals + display in palette B (hammer, evidence) |
| **Mono** | `"JetBrains Mono", "Cascadia Code", ui-monospace, monospace` | All numerics: price, seq, hashes, countdown, drift Δ — both palettes |

Always combine mono with `tabular-nums` for vertical column alignment in
tables, leaderboards, hash ledgers.

### §6.3 Motion

All motion is **CSS `@keyframes`** in `src/styles.css`. There is no
animation library — every animation runs on compositor-friendly
properties (`transform`, `opacity`, `box-shadow`) so the WS message
handler stays free.

| Class                    | Duration · easing                    | Reserved for                                   |
|--------------------------|--------------------------------------|------------------------------------------------|
| `lumen-pulse-warn`       | 0.9s ease-in-out infinite            | F01 — final-10s scale + drop-shadow pulse      |
| `lumen-ring-pulse`       | 1.1s ease-out infinite               | F01 — ring expand around the countdown card    |
| `lumen-sweep`            | 1.0s ease-out 1                      | F02 — anti-snipe light-sweep across price card |
| `lumen-gold-flash`       | 1.2s ease-out 1                      | F06 — own-bid gold background flash            |
| `lumen-shake`            | 0.36s cubic-bezier(.36,.07,.19,.97)  | F08 — bid reject left-right shake              |
| `lumen-veil-drop`        | 1.05s cubic-bezier(.6,.04,.32,1)     | Hammer transition — gold veil falls from top   |
| `lumen-veil-bridge-fade` | 0.35s ease-in 1                      | Hammer transition — bridge palette layer       |
| `lumen-room-blur-out`    | 1.05s ease-out 1                     | Hammer transition — room blur + dim            |
| `lumen-hammer-reveal-up` | 0.9s cubic-bezier(.22,1,.36,1), 0.7s delay | Hammer transition — final solemn reveal  |
| `lumen-lead-pop`         | 1.6s cubic-bezier(.34,1.56,.64,1)    | F06 — "领先" badge entry                       |
| `lumen-slam-in`          | 0.42s cubic-bezier(.36,.07,.19,.97)  | F07 — overtake banner slam from top            |
| `lumen-black-horse-in`   | 0.5s cubic-bezier(.34,1.56,.64,1)    | F13 — jump-bid horse banner                    |
| `lumen-shockwave`        | 1.4s ease-out 1                      | Hammer — champagne ring expand                 |
| `lumen-dust`             | 2.8s ease-out infinite               | Hammer — gold dust slow rise                   |
| `lumen-marquee`          | 14s linear infinite                  | F13 — horizontal text marquee                  |
| `lumen-wheel-in`         | 0.35s cubic-bezier(.34,1.56,.64,1)   | F25 — long-press bid wheel entry               |
| `lumen-flame-flicker`    | 0.45s ease-in-out infinite           | F10 — combo flame                              |
| `lumen-heartbeat`        | 0.9s ease-in-out infinite            | Final-10s heartbeat vignette                   |
| `lumen-ticker-up`        | 3.6s ease-out 1                      | Bid ticker pill rise + fade                    |
| `lumen-shimmer`          | 1.4s linear infinite                 | ConnectionBar reconnecting shimmer             |
| `lumen-cursor-blink`     | 1s steps(2) infinite                 | AI typewriter cursor                           |
| `lumen-spotlight`        | 3s ease-in-out infinite              | Leaderboard rank-1 spotlight cone              |

**Principle (P8 + P9)**: All decorative motion is gated by
`.surface-calm` (frame-budget auto-degrade) and `prefers-reduced-motion`
— both reduce to `animation: none` for the listed classes (see
bottom of `src/styles.css`).

------------------------------------------------------------------------

## §7 Component inventory

**Already built** in the design pass shipped 2026-05-26. File paths
below are real; open them to see the implementation.

### §7.1 Primitives (`src/components/primitives.jsx`)

| Component | Anchors principle | Notes |
|------------------------|------------------------|------------------------|
| `<PriceDisplay cents size variant>` | P1 | Receives string cents; mono tabular-nums |
| `<Countdown remainingMs warning>` | P4, P8 | CSS pulse via `lumen-pulse-warn`; reads `msRemaining(endAtMs)` upstream |
| `<StatusBadge status>` | P2 | Maps each of 7 canonical states to CN label + state-semantic color |
| `<ExtendBadge count perExtendSec>` | P5 | F02 `lumen-sweep` on count change |
| `<AIBubble status trigger text>` | P3 | First-class `status='offline'` branch with canon copy + `lumen-cursor-blink` typewriter |
| `<TypewriterText text>` | — | Char-by-char reveal; used by AIBubble streaming |
| `<Leaderboard leaders yourUserId>` | F11/F12 | Gold/silver/bronze halos + `lumen-you-pulse` on your row |
| `<BidButton currentCents stepCents disabled rejectShake>` | F08 | `lumen-shake` on rejectShake; F25 long-press wheel hook (gesture TODO) |
| `<ConnectionBar status detail>` | P7 | `reconnecting` / `syncing` / `schema` states; `lumen-shimmer` for syncing |

### §7.2 Atmosphere (`src/components/atmosphere.jsx`)

| Component | Purpose |
|---|---|
| `<LeadingToast>` | F06 — `lumen-lead-pop` + `lumen-lead-ring` "领先!" |
| `<OvertakenSlam>` | F07 — `lumen-slam-in` top banner |
| `<SandHourglass>` | F03 — falling-sand hourglass during final 10s |
| `<PulseWaves>` | Concentric `lumen-pulse-wave` from price card in final 10s |
| `<LongPressBidWheel>` | F25 — radial 1×/2×/5×/10× step picker |
| `<BlackHorseBanner>` | F13 — `lumen-black-horse-in` + marquee for jump bids |
| `<HammerTransition>` | A→B crossover — `lumen-veil-drop` + `lumen-veil-bridge-fade` + `lumen-room-blur-out` |
| `<DustParticles>` / `<ShockwaveRing>` | Hammer celebration |
| `<SpeakerMutePill>` / `<ComboFlame>` | Sundry atmosphere |

### §7.3 Screens

| Module | Screen | Surface |
|---|---|---|
| `mobile.jsx` → `<MobileRoom>` | Buyer Room (default, final-10s, leading, all atmosphere flags) | Mobile H5 |
| `mobile.jsx` → `<MobileHammer>` | Hammer transition + solemn SOLD reveal | Mobile H5 |
| `mobile.jsx` → `<MobileEvidence>` | Evidence card with hash-chain timeline (CHAIN VERIFIED / CHAIN BROKEN variants) | Mobile H5 |
| `admin.jsx` → `<AdminVLMFacts>` | **Hero of admin** — VLM facts 5-card review with edit/diff/confirm | Desktop 1440px+ |
| `admin.jsx` → `<AdminConsole>` | Mission-control live console — bid stream + AI preview + danger zone | Desktop 1440px+ |
| `adminExtra.jsx` → `<AdminPublish>` | New auction 5-step form with pipeline visualizer | Desktop 1440px+ |
| `adminExtra.jsx` → `<AdminOrders>` | All auctions + orders table with GMV summary cards | Desktop 1440px+ |
| `adminExtra.jsx` → `<AdminCancelModal>` | 2-step cancel (type current price to verify) | Desktop modal |
| `misc.jsx` → `<MiniProgramStub>` | "请在抖音 App 内打开" landing per §12 §7.1 → C | Mobile H5 |
| `misc.jsx` → `<ConnReconnecting>` / `<ConnSyncing>` / `<ConnSchema>` | Full-screen WS connection state overlays | Mobile H5 |

### §7.4 Wire-up status

| Screen | Standalone (mock) | Backend-wired |
|---|---|---|
| `<MobileRoom>` via `/preview/room` (and `:final10` / `:leading`) | ✅ | ⬜ — uses props only |
| `<MobileRoom>` via `<LiveRoomRoute>` at `/room/:auctionId` | n/a | ✅ — full WS + REST chain (dev-login → snapshot → leaderboard → ROOM_JOIN) |
| `<MobileHammer>` / `<MobileEvidence>` | ✅ via `/preview/*` | ⬜ — needs evidence fetch + status-change subscription |
| Admin screens | ✅ via `/admin/*` | ⬜ — `api.*` stubs exist but routes haven't been wired yet |

The Room route (`src/routes/LiveRoomRoute.jsx`) is the canonical
backend-wiring example; all other screens follow the same pattern:
ensure session → REST snapshot → optional REST refresh → open WS (or
just REST for static pages like Evidence and Orders).

------------------------------------------------------------------------

## §8 Feature catalog

### §8.1 Must (Elia review locked these on parent issue)

Each entry hits ≥1 of {backend invariant / AI落地 / materials}. Pure
aesthetic features were demoted to nice-to-have.

| ID | Feature | Backend anchor |
|------------------------|------------------------|------------------------|
| F02 | Anti-snipe extend badge + light-sweep | `AUCTION_EXTENDED` event + `extendCount` (P5) |
| F05 | Server-clock drift Δ indicator | Every envelope's `serverTimeMs` (P4) |
| F19 | AI offline degrade badge | AI sidecar non-authoritative architecture (P3) |
| F20 | VLM facts confirmation page (admin) | T7 AI sidecar VLM endpoint, gates SCHEDULED→LIVE |
| F26 | Pull-to-refresh = ROOM_JOIN(lastSeq) | Catchup protocol (P7) |
| F28 | Reconnect catchup fast-forward | Stream XRANGE delta replay (P7) |
| F31 | Evidence hash-chain timeline | `auction_events.event_hash`/`prev_hash` (P6) |

### §8.2 Tension arc (the demo's 30-second silent storyboard)

In order: **F01 → F06/F07 → F09 → F12 → F14/F15 → F23**

| Beat | Feature | What's on screen |
|------------------------|------------------------|------------------------|
| 1 (T-10s) | F01 末-10s 红圈脉冲 | Countdown digits go red, CSS pulse intensifies |
| 2 (own bid) | F06 「你领先了」 | Full-screen gold flash + haptic |
| 3 (overtake) | F07 「被超越」 | Top-bar red banner drops, CTA "再加 X 反超" |
| 4 (any bid) | F09 价格 odometer | Number flips digit-by-digit |
| 5 (any bid) | F12 排行榜 FLIP | Avatars fly to new positions |
| 6 (hammer) | F14 心跳音 → F15 落槌音 | Audio (gated on §7.2 OPEN DECISION, currently default-mute) |
| 7 (after hammer) | F23 Hall of Fame | Solemn palette + winner reveal + evidence CTA |

### §8.3 Deferred (Nice / P1)

F03 sand hourglass, F04 background color-temperature ramp, F10 combo
counter, F13 黑马 banner, F16 mid-bid tones, F17 default-mute setup, F18
LLM streaming bubble (needs T7 backend), F21 viewer count, F22 上车
ticker, F24 心动值, F25 long-press tier wheel, F27 haptics, F29/F30
terminal end-states (built but minimal), F32/F33/F34 Douyin-specific
(福袋/弹幕/礼物特效).

------------------------------------------------------------------------

## §9 Anti-slop checklist

A proposal is **rejected** if it contains any of the following without
semantic justification. This is the §11 disqualifier list referenced by
P10.

### §9.1 Banned by default

-   **Purple → blue → pink gradients on white** (generic AI default)
-   **Glassmorphism** as decoration (allowed only if it solves z-index
    legibility over busy backgrounds)
-   **Centered hero with stock-photo-shaped placeholder + 3-word
    headline + emoji cluster**
-   **Inter / Roboto / Arial / SF system stack as display face** — too
    generic; we use PingFang SC / Noto Serif SC instead
-   **Drop shadows with no light source consistency** — pick one
    direction and commit
-   **Skeuomorphism on auction-house elements** — no faux-wood gavels,
    no leather textures
-   **Lottery-game patterns** — confetti spam, lucky-draw wheels,
    "scratch to reveal", spinning prize doors. (Auctions ≠抽奖.)
-   **Generic stack: card-grid-of-three identical tiles with bold
    title + lorem + outlined button**

### §9.2 Allowed only with semantic anchoring

-   Gradient → only when it represents temperature change (countdown
    urgency), state change (hammer reveal flip), or directional emphasis
    (sticky CTA fade-shield for legibility, marked
    `data-decorative="false"`)
-   Glow/halo → only on rank affordance (Top-3 medals) or "you are
    leading" feedback
-   Particles → only at hammer overlay (gold dust / champagne) and only
    at low density
-   Blur → only behind modals/overlays for separation
-   3D / tilt → forbidden without explicit purpose
-   Emoji → small, semantic, paired with text — never standalone
    decoration

### §9.3 Required

-   **Tabular numerics** wherever numbers update or align in columns
    (prices, seq, leaderboard amounts, hashes, countdown digits)
-   **Real `prefers-reduced-motion` support** (already wired via
    `surface-calm` class)
-   **All colors come from the §6.1 token table** — no inline hex except
    token additions explicitly proposed
-   **Status text in copy matches §3.1 canonical names** — never
    "Hammered", "Cooling", "Ending"
-   **Mobile safe-area-inset** awareness on iPhone (top notch + bottom
    home indicator)

### §9.4 Cultural fit (Chinese-first audience)

-   CN-dominant copy with EN labels for technical terms (seq, hash,
    schema) is correct — this is the project house style
-   Numerals: ¥1,234.56 with proper grouping; cents always 2 digits
-   Don't anglicize labels for the sake of it. "Live" → "直播中"
    (already in StatusBadge)
-   Auctioneer / 拍卖师 framing is acceptable in CN; "Auctioneer" in EN
    is not warm enough

------------------------------------------------------------------------

## §10 Hero moments (the screens that justify the design)

These are the eight moments the design must nail. If a proposal only
nails layout but flattens these, it fails.

| \# | Moment | Why it matters | Constraints |
|------------------|------------------|------------------|------------------|
| 1 | **Final 10 seconds before hammer** | Maximum tension, judges' lasting impression | Countdown pulse rises in frequency; background color temperature optional ramp; haptic on each second optional; no chrome that competes with the timer |
| 2 | **Anti-snipe extension trigger** | F02 — the trust differentiator | Visible `AUCTION_EXTENDED` light sweep across the timer; `extendCount +1` badge animates; new `endAtMs` resets the timer with a 1-frame "snap back"; must NOT feel like a glitch |
| 3 | **Own-bid acceptance ("领先!")** | F06 — emotional reward | Brief gold flash from the price card outward; haptic; "领先!" copy floats; clears in \~1.2s; no permanent UI cost |
| 4 | **Being overtaken** | F07 — re-engagement | Red top banner drops with "被超越 · 加价反超 ¥X"; CTA on the banner increments to next valid bid; banner persists until next own action |
| 5 | **Reject feedback** | F08 — clarity over apology | Bid button left-right shake (0.36s); semantic toast (e.g. "出价低于最低加价或超过上限"); no modal interruption |
| 6 | **The hammer (status → SOLD)** | The product's center of gravity — A→B accent flip | Background fades to `solemn-deep`; serif gold price reveal (\~7xl); winner name in serif cream; CTA "查看证据卡 →" appears at delay 0.6s; gold dust particles low-density |
| 7 | **Evidence screen entry** | Backs up the claim — P6 + F31 | Continuous from hammer (no jump cut); top: chain-verified badge or break flag; timeline as a vertical ledger; mono-tabular hashes; `prev_hash → event_hash` link visible per row |
| 8 | **VLM facts confirmation (admin)** | The 15% AI rubric chunk + #42 hero of admin | Full-screen review; each VLM-drafted fact on its own card with edit/confirm/delete; "diff" visible if seller modified; progress to "all confirmed" gate visible; cannot proceed to SCHEDULED until 100% |

------------------------------------------------------------------------

## §11 Tech stack & file layout

Designs that are impossible to ship in 14 days do not help us. The stack
is fixed:

| Layer | Choice | Why |
|------------------------|------------------------|------------------------|
| Runtime | React 18 | Production-stable; matches the design pass shipped 2026-05-26 |
| Bundler | Vite 5 | Fast dev; production builds <90KB gzipped today |
| Language | JavaScript (JSX) | Design pass shipped JS to maximize iteration speed; can be migrated to TS post-freeze if there's appetite |
| Styling | Pure CSS custom properties on `:root` (no Tailwind) | Tokens in `src/styles.css`; CSS-first; the design uses inline `style={…}` extensively |
| State | Zustand v4 | Lightweight; reducer-style WS event mapping (see `src/store/auction.js`) |
| Routing | react-router-dom v6 | Browser router; routes in `src/App.jsx` |
| Animation | CSS `@keyframes` on compositor-friendly properties (transform/opacity) | No animation library — pure CSS for P8 compliance |
| Real-time | Native WebSocket (`src/lib/ws.js`) | Matches backend `proto/ws-envelope.md`; no socket.io |

**File layout** (current, as shipped):

```         
lumen-frontend/
├── docs/
│   ├── design-system.md         ← (this file)
│   └── project-blueprint.md     ← engineering / functional spec
├── index.html                   ← Vite entry
├── vite.config.js               ← /api + /ws proxy → backend
├── .env.example                 ← VITE_API_BASE, VITE_WS_BASE, USE_MOCK_DATA
├── package.json
└── src/
    ├── main.jsx · App.jsx       ← React + BrowserRouter root + route table
    ├── styles.css               ← All design tokens (§6) + CSS animations
    ├── lib/
    │   ├── auth.js              ← dev-login + JWT bearer storage
    │   ├── api.js               ← REST client (/api/*) with auth
    │   ├── ws.js                ← RoomClient: envelope · seqguard · reconnect · clock skew
    │   ├── types.js             ← AuctionStatus · EventType · BidErrorCode · bidRejectCopy
    │   ├── clock.js             ← serverNow() / msRemaining() / setClockOffset()
    │   └── format.js            ← formatCentsCNY / addCentsStr / fmtRemaining (BigInt)
    ├── store/
    │   └── auction.js           ← Zustand store; applyEvent reducer over WS envelopes
    ├── routes/
    │   ├── IndexPage.jsx        ← Dev landing — links to every screen
    │   └── LiveRoomRoute.jsx    ← Real backend-wired Room (session → snapshot → WS)
    └── components/
        ├── MobileFrame.jsx · DesktopShell.jsx   ← Device wrappers
        ├── primitives.jsx       ← PriceDisplay · Countdown · StatusBadge · AIBubble · Leaderboard · BidButton · ConnectionBar
        ├── atmosphere.jsx       ← LeadingToast · OvertakenSlam · SandHourglass · PulseWaves · LongPressBidWheel · BlackHorseBanner · HammerTransition
        ├── mobile.jsx           ← MobileRoom · MobileHammer · MobileEvidence
        ├── admin.jsx            ← AdminVLMFacts · AdminConsole
        ├── adminExtra.jsx       ← AdminPublish · AdminOrders · AdminCancelModal
        └── misc.jsx             ← MiniProgramStub · ConnReconnecting / Syncing / Schema
```

------------------------------------------------------------------------

## §12 Open decisions (locked from parent issue review)

These were proposed in the parent issue's §7; here are the locked
outcomes (post-review) the design must honor.

| \# | Topic | Locked answer | Implication for design |
|------------------|------------------|------------------|------------------|
| §7.1 | Mini-program (Douyin 小程序) | **C — H5 P0 + Mini-program stub-only** | Don't design Mini-program native flows; do design a stub landing page ("请在抖音 App 打开") |
| §7.2 | Sound default | **A — default mute + breathing speaker icon** | All audio (F14/F15/F16/F17) starts muted; speaker icon in header to enable |
| §7.3 | Animation vs perf SLO | **B — frame budget auto-degrade** | Decorative motion is removable; semantic motion must work in `surface-calm` mode |
| §7.4 | PC ↔ H5 design language | **A — shared tokens, different density** | Same palette and motion language; PC uses denser spacing, larger info density |
| §7.5 | AI bubble offline copy | **Keep visible + gray badge** | Copy locked: "拍卖师暂离 · 出价不受影响" |

------------------------------------------------------------------------

## §13 Engineering invariants you cannot violate

To make these audit-able as a designer:

1.  **No new color value** that isn't in the §6.1 token table, or
    proposed as a token addition with a name and a semantic
    justification.
2.  **No "Number"-shaped money**. All currency receives `cents: string`.
3.  **No `Date.now()`-driven countdown logic.** Always go through
    `serverClockOffsetMs`.
4.  **No 8th state** in any flow diagram, screen list, or copy.
5.  **No silent reconnect**. The reconnect/catchup state always has UI.
6.  **No 60fps React-state-driven animation.** Continuous motion must be
    CSS/WAAPI.
7.  **No purely decorative gradient.** If it isn't an event-anchored
    color shift or a legibility shield, it doesn't ship.

------------------------------------------------------------------------

## §14 Design exploration ask

For each of the **6 anchor screens** below, deliver: 1. **High-fidelity
static mockup** (mobile screens at 390×844; desktop screens at 1440×900
or 1920×1080) 2. **Two variations** showing different aesthetic
intensity within the A+B accent rule (one restrained, one expressive) 3.
**Annotation overlay** calling out the §10 hero moments visible on that
screen and which §3 wire events drive them 4. **One detail close-up**
per screen showing typographic and color treatment at component level 5.
**Anti-slop self-check** (a 5-bullet note saying which of §9.1's bans
you actively avoided and how)

### §14.1 Anchor screens

1.  **Mobile H5 — Room (LIVE, 30s remaining)** — countdown active,
    leaderboard populated, bid CTA at thumb-reach, AI bubble with one
    auctioneer line, ExtendBadge showing `延时 ×2 +60s`
2.  **Mobile H5 — Room (final 10s)** — F01 pulse engaged, color
    temperature ramp on/off variants
3.  **Mobile H5 — Hammer overlay (status SOLD)** — the A→B accent
    crossover moment, gold dust, winner reveal
4.  **Mobile H5 — Evidence screen** — solemn deep + gold serif; timeline
    of 6–8 events with mono-tabular hashes; chain head visible at
    bottom; "back to room" affordance
5.  **PC Admin — VLM facts confirmation** — full-screen hero; \~5 fact
    cards (品牌/型号/成色/瑕疵/关键参数) showing VLM-drafted text + diff
    if edited + per-card confirm/edit/delete; bottom-bar gate
    "全部确认后开拍" (disabled until 100%)
6.  **PC Admin — Live console** — big status bar at top; live bid stream
    as a vertical ticker; AI text preview panel (read-only); danger zone
    with cancel button leading to the 2-step modal

### §14.2 Stretch (if time permits)

7.  PC Admin — Cancel-with-confirmation modal (asks seller to type
    current amount to verify)
8.  Mobile H5 — Connection states (reconnecting, syncing #N→#M, schema
    mismatch)

### §14.3 What to optimize for

In rough priority: 1. **Demo legibility** — the 30s silent storyboard
(§8.2) must read without sound or explanation 2. **Backend invariant
visibility** — every §4 principle visible somewhere on screen 3.
**Cultural fit** — feels like a Douyin product made by people who
respect auctions, not vice versa 4. **Restraint** — under §9, an answer
that does less but does it right beats one that does more 5.
**Production feasibility** — every element must be implementable in the
§11 stack within 14 days

------------------------------------------------------------------------

## §15 References

For the curious or for verification — none of these are required to
complete the exploration in §14:

| Source | What lives there |
|------------------------------------|------------------------------------|
| `proto/ws-envelope.md` (in `Eliaaazzz/live-auction-system`) | The wire contract referenced in §3 |
| `proto/error-codes.md` | Bid rejection codes (semantic copy in `bidRejectCopy`) |
| `proto/evidence-card.md` | Evidence schema referenced in §3.4 + §10 moment 7 |
| `docs/state-machine.md` | Canonical 7-state diagram referenced in §3.1 + §4 P2 |
| GitHub issue #41 | Parent design brainstorm (feature/style brainstorm + evaluation framework) |
| GitHub issue #42 | PC admin sub-issue (VLM hero + console framing) |
| GitHub issue #43 | Mobile H5 sub-issue |
| GitHub PR #34 | T4 evidence hash chain (the backend that makes §10 moment 7 real) |

------------------------------------------------------------------------

## §16 What's *not* in scope for this design pass

-   Logo / brand identity development
-   Marketing pages, landing pages, About pages
-   Authentication flows beyond dev-login affordance
-   Payment / checkout flow
-   Push notification design
-   iOS/Android native app design
-   Pre-auction product discovery (browse, search, filter)
-   Post-sale review, ratings, returns

------------------------------------------------------------------------

## §17 Tone for the design

A summary in one paragraph, suitable for a designer reading this on a
Friday afternoon:

> Lumen Auction is a livestream auction that wants to feel honest. We're
> competing in a context flooded with lottery-game UIs (转盘, 福袋,
> 抽奖) and we want the opposite — credibility. The product surfaces
> real backend guarantees (hash-chained evidence, monotonic sequence
> numbers, server-clock-corrected countdowns, anti-snipe extensions,
> graceful reconnect) and the design's job is to make those guarantees
> *visible* without becoming an engineering dashboard. Default surface
> is Douyin energy (red on black, snappy springs, mobile-thumb-first) so
> the live tension lands. At the hammer, the world flips to
> auction-house gravitas (deep navy, champagne gold, serif numerals) to
> mark the recorded moment. Decoration only appears at emotional events;
> the rest is restraint. Numerics are tabular-mono. Copy is CN-dominant
> with EN technical labels. The judges are Douyin engineers, so we have
> to look like we belong on Douyin while clearly being *more* engineered
> than typical livestream commerce.
