# dev-log 2026-05-26 — @fariZzzz — T6 review cycle (FE stack + design ratify)

Per [#15](https://github.com/Eliaaazzz/live-auction-system/issues/15) Workflow v2. Not a fresh trunk step — today was the **T6 frontend review cycle**: addressing @Eliaaazzz's reviews on the stack I opened yesterday (#49 → #51 → #53 → #54), reversing a couple of my own initial positions, and coordinating with the parallel artefacts (@PDGGK #50, @Eliaaazzz #52, #55, #57). Also opened two contract-gap issues (#60 backend snapshot rules, #61 verify semantics) that surfaced during the cycle.

This dev-log is heavier on "what reviewers caught that I missed" than on "what I shipped" — per V9 §5 challenger discipline, the diary entries should expose the gaps, not paper over them.

## What was already done (yesterday's stack)

The PRs were all in place: #49 design pass + wire, #51 P9/Evidence/Cancel/F26, #53 admin Publish/VLM/Console wiring, #54 buyer polish (Top-3 podium / chips / heat meter / SOLD shake). Test-cases doc shipped with 75 cases (15 covered + 15 gap probes + 45 from PR #54's review-pass).

Awaiting review going into today.

## What changed today

### Bugs reviewers caught that my self-review missed

1. **M5 — `!evidence.chainVerified` false-positive CHAIN BROKEN** (PR #51, @Eliaaazzz). Subtle but real demo-risk: if the backend response omits the `chainVerified` field for any reason (old backend / fetch error / schema drift / version skew during the freeze window), `!undefined === true` flips on the red alarm visual. My code uses the negative-truthy idiom; the correct form is explicit `=== false` so missing-field stays neutral. **Fixed in `ddeeabd`** on #51 → cascaded into #53/#54 via rebase. Test-case TC-T6-107 status note updated.

2. **Chip visual hierarchy reversed** (PR #54 → led to @Eliaaazzz's #57). My `+5% · ¥14K` had the delta as primary visual and the resulting amount as secondary. Wrong. Elia's cross-platform research (Whatnot / eBay / Sotheby's / 淘宝直播 / TikTok Countdown Bidding) showed every live-auction app puts the **resulting amount** as the primary visual. Conceptually my framing came from generic e-commerce ("save 5%"), not auction UX ("the next bid is ¥133,800, which is one step up"). #57 inverts this + relabels `+1%/+5%/+10%` → `+1档/+3档/+10档` using native auction-house dialect. Reviewed + approved with one P2 raise (MAX with non-grid `capCents`).

3. **`store.stepCents = '0'` default** (PR #54-H1, @Eliaaazzz). Caught by Elia as a silent-panic chain: store default → BigInt divide-by-zero in `pctBump` → caught by `try/catch` → chip falls back to `currentCents` → user taps → backend `ERR_TOO_LOW`. I'd architected the QuickBidChips math correctly but seeded the store with a value that broke it. Two-layer fix in #54: store default → `'500000'` + in-component `stepUsable` guard with visible "加价阶梯未配置" hint. Root-cause issue #60 opened for backend (snapshot doesn't ship rules; client shouldn't need a fallback).

4. **`tabularNums: true` React silent-drop** (PR #54-H3 → fixed in #57). React silently drops camelCase non-CSS props; the correct form is `fontVariantNumeric: 'tabular-nums'`. My HeatMeter's bids/sec digits were not actually monospace, despite the prop. Caught by Elia in #57 review; landed inside #57's `+96/-38` diff.

### Position reversal on #56 design comparison

My opening §3.1 vote was "keep all three references parallel" (A trunk + B PDGGK Claude docs + C Elia round-2 prototype). @Eliaaazzz counter-proposed: maintaining three parallel references is review cost ×3 + drift risk N². His framing was right — "留下不等于 parallel,留下应该是以正确形式落进 trunk."

**Reversed my vote**:
- A trunk = production source-of-truth (unchanged)
- B = A's **generated artifact** (CI extracts tokens from `:root` → emits `apps/web/docs/claude-design-system/colors_and_type.css`; diff != 0 → red)
- C = close #52, port Tweaks panel into A via `?tweaks=1` dev-only mode, archive prototype to `apps/web/docs/design-references/round-2-prototype/`

Committed to writing the token-extract CI script if @PDGGK ratifies the "B as generated" framing.

### Other code work

- **`handleFreezeAndStart` idempotency** (PR #53-H1). Freeze → ERR_BAD_STATE on retry meant orphaned SCHEDULED auctions. Now treats ERR_BAD_STATE on freeze as "already frozen, proceed to startLive" — both via the `OK_FROZEN` code branch and the thrown-ApiError branch. Doesn't swallow ERR_BAD_STATE on startLive (different problem). Forward-compatible with a future backend idempotency token.

- **JWT 401 auto-clear + HMAC custody inline summary** (PR #51 follow-up `646c52b`). 401 from REST now calls `handleAuthFailure()` → `clearSession()` + global `lumen:session-expired` custom event. Inlined a 3-paragraph threat-model summary at the top of `EvidenceRoute.jsx` so devs reading the route file see the "integrity check, not blockchain-secured" caveat without having to click out to `proto/evidence-card.md §6`.

- **NO_BID / CANCELLED terminal overlay** (PR #54-H2, self-added). MobileRoom previously rendered HammerTransition only for SOLD; NO_BID and CANCELLED just flipped the StatusBadge. Added `<TerminalOverlay>`: quiet semi-transparent gradient (calm gray for NO_BID, dim red for CANCELLED), single 0.4s fade-in via `lumen-veil-bridge-fade` keyframe. Note: this keyframe needs to be added to the `.surface-calm` mute list in styles.css for P9 consistency — flagged for Elia in #54 reply.

- **Custom drawer MaxMoneyCents cap** (PR #54-H3). `maxLength={17}` + onChange slice + BigInt validation + inline CN error copy for parse/low/max cases. Closes the round-trip-to-ERR_BAD_INPUT loop.

## Process / coordination work

- **4-branch force-rebase cascade** onto current main (T4 + T5 newly in base). Per @Eliaaazzz's B1 blocker. Side-effect: @PDGGK's #50 base reference went stale → pinged him with the rebase instructions.
- **Stripped `🤖 Generated with Claude Code`** from #51/#53/#54 PR bodies. Elia flagged it as a CLAUDE.md violation; my memory had it as PR-body-OK based on an earlier convention, now updated to "strip everywhere."
- **Closed 4 issues + 3 stale PRs** (#14 scaffolding RFC done · #41 design parent · #42 PC admin sub · #43 H5 sub · #25 mentor-sync runbook · #35 T4 test-case doc · #16 components breakdown). Each with closure rationale comment.
- **Closed #36** (one-T-per-PR process RFC) — answered in practice by the team's actual cadence (solo PRs default, rollup only when forced by a base-fix). No further RFC needed.
- **Opened #56** (design comparison + vote thread); reversed my own §3.1 vote later same day after Elia's counter-proposal.
- **Opened #60** (backend `RoomSnapshotData` should ship rules) — root cause of #54-H1 silent panic.
- **Opened #61** (T6 evidence verify semantics ratify — passive vs active) — surfaced in #56 §3.4 Gap 2.

## Tests (edge cases → doc, executable still gapped)

Test-case doc `apps/web/docs/test-cases/T6-frontend-wire.md` now sits at 75 cases (15 covered + 15 gap probes + 45 PR-specific). Coverage matrix:
- **smoke** (`scripts/smoke-wire.mjs`): 001, 004-013 — wire envelope + dual-broadcast dedupe + heartbeat + reject path. Re-run today against current main + rebased branches → ALL ASSERTIONS PASS.
- **code-verify** (static): everything else.
- **executable** (Playwright): **0** — biggest remaining gap.

The four highest-value cases still need real e2e:
- TC-T6-100 (anti-snipe extend + sweep)
- TC-T6-102 (reconnect lastSeq catchup)
- TC-T6-103 (gap > 200 snapshot fallback)
- TC-T6-200 series (admin Publish full chain)

A `fari/T6-playwright-e2e` follow-up is the next logical work; not blocking T6 acceptance gate today.

## Review pass (docs/review.md)

- **Contract drift** — none. M5 fix is a presentation-layer guard; #57 stepBump is a math rewrite with the same input/output types; the JWT 401 path is purely client-side. No `proto/*` files touched.
- **Correctness** — M5 fix is the only "real bug landed today" finding; freeze-orphan was a state-machine hole, not a wire bug. Both have explanatory comments in the diff. The H2 NO_BID/CANCELLED overlay I added is purely additive — renders only on terminal states, doesn't intercept SOLD's existing crossfade.
- **Concurrency** — `handleFreezeAndStart` two-step idempotent path: each call is independent; concurrent retries by the same user produce at-most-one auction state transition (backend Lua-atomic).
- **Perf** — bundle at #54 tip is 89.92 KB gzip (+1.7 KB across the whole review-resolution batch). No new dependencies. The frame-budget P9 guardrail (ported from old lumen-web prototype) is the only runtime addition.

## Coordination state at EOD

| Thread | State |
|---|---|
| PR #49 | CI green, rebased onto main, ready-for-review |
| PR #50 (@PDGGK) | Pinged for rebase; awaiting his action |
| PR #51 | CI green, all review findings addressed (M5 / H2 / H3 / H4), ready-for-approve |
| PR #53 | CI green, H1 freeze-orphan fixed, ready-for-approve |
| PR #54 | CI green, H1 / H2 / H3 fixed, ready-for-approve |
| PR #57 (@Eliaaazzz) | Reviewed + approved with 1 P2 raise; rebased onto my latest #54 tip |
| Issue #56 | My §3.1 vote reversed to align with Elia; awaiting @PDGGK on §3.2 (B-as-generated) |
| Issue #60 | NEW — backend rules in snapshot (T7 fold-in candidate) |
| Issue #61 | NEW — verify passive vs active ratify |
| Branch `elia/redact-spec-apikey` → PR #59 | Merged to main — security redaction of committed Doubao credentials |
| PR #55 (T6 Replay Verifier) | Merged to main today |

## Deferred (honest)

- **TC-T6-100/101** anti-snipe e2e — still no executable test. Highest-priority remaining gap. Needs Playwright + a backend fixture that can be told to end in 5s.
- **`fari/T6-room-perf-polish`** — Elia's review #51-H2 (`onTouchCancel`) + #51-H3 (PullToResync sizing) + #51-H4 (CancelOverlay hardcoded price) + #53-H2 (AdminConsole useAuctionStore selector) + #53-H3 (window.prompt → inline editor) + #54-M1/M2/M4. All defer-accepted by Elia; sweep into one polish PR after this stack lands.
- **`fari/T6-token-extract-ci`** — write `scripts/extract-tokens.mjs` to generate `apps/web/docs/claude-design-system/colors_and_type.css` from `src/styles.css :root`, drift gate in CI. Pending @PDGGK ratify on #56 §3.2.
- **`fari/T6-tweaks-panel-port`** — port C's interactive `tweaks-panel.jsx` into A as `?tweaks=1` dev-only mode. Elia volunteered; I can pick up if he's busy.
- **`fari/T6-bid-rejected-displayname`** — bonus question I raised in #53 reply: should BID_REJECTED carry `displayName` for AdminConsole's LAST 3 REJECTS panel? Backend wire-contract additive, ratify-grade — open thread, not actioned today.

## Lessons / reflections

1. **My self-review missed three of the four bugs Elia caught**: M5 (negative-truthy false-positive), stepCents=0 silent panic, chip visual hierarchy. Pattern: I tested *that the code worked* on the happy path; I didn't test *what happens when an input falls outside my mental model*. The test-cases doc captured the inputs in retrospect but not before review. Better: writing the failure-mode test cases BEFORE the code (the team's #30 → #35 "test-cases first" pattern), even informally.
2. **Premature commitment in #56**. My opening "keep all 3 parallel" was the wrong answer to "what should happen to the design references." I leaned toward inclusion to avoid offending anyone; Elia's "review cost × 3 + drift N²" was an argument I could have made myself but didn't. Note for next governance thread: my default should be the one that minimizes long-term maintenance, not the one that maximizes optionality.
3. **Force-rebase has externalities I underweighted**. Force-pushing #49 stranded @PDGGK's #50 base reference. I asked + got authorization before doing it, but didn't volunteer "this will require a rebase from PDGGK" until after the fact. Next time: flag downstream branch impact in the rebase-confirmation question.
4. **The "🤖 Generated with Claude Code" PR-body lines should have been stripped from day one.** My memory had an exception for PR bodies based on an earlier conversation; Elia's CLAUDE.md reading is the right one. Memory updated; future PRs won't have this.

---

**Refs**:
- All four open PRs in the T6 stack: #49 · #51 · #53 · #54
- Design refs: #50 (PDGGK Claude docs — draft, needs rebase) · #52 (Elia round-2 prototype — to be archived per #56 vote) · #57 (Elia bid panel v2 — approved with raise)
- Design governance: #56 (vote thread, awaiting @PDGGK)
- Contract gaps surfaced: #60 (snapshot rules) · #61 (verify semantics)
- Tomorrow's stack-land target per #56 §4: 2026-05-27
