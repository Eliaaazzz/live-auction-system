# dev-log 2026-05-28 — @fariZzzz — T6 sealing + T7 sprint (§4.2 / §4.3 / §4.5 landed)

Two-day span (5/27 → 5/28). Yesterday closed out T6 (#49 stack root + #65 test suite + #66 README all landed on main); today claimed three of the five §4 sub-deliverables under @Eliaaazzz's T7 tracking issue [#70](https://github.com/Eliaaazzz/live-auction-system/issues/70) and shipped them with same-day approval + merge. Plus a substantive review on @Eliaaazzz's parallel #73 contract PR, one cross-PR coordination fix, an old-issue audit, and three rebase-and-CI-green passes on the chronic CHANGES_REQUESTED PRs.

Method through the T7 work: **own both halves of the wire**. Sidecar Go package + frontend reducer in the same PR so the contract is exercised end-to-end on local CI, not just specified. Same pattern as Elia ran with #38 backpressure (impl + tests in one diff).

## T6 sealing — what landed on main (5/27)

### #65 test suite review B1 — CI integration, not "tests on disk"

@Eliaaazzz's [deep review](https://github.com/Eliaaazzz/live-auction-system/pull/65#issuecomment-4545179141) on the test suite PR caught one **BLOCKING**: 114 Vitest cases shipped, but `.github/workflows/ci.yml` had no `web` job. Tests-as-disk, not tests-as-gate. Any future commit breaking `store/auction.js` or a primitive component would pass main's existing 3 CI jobs and only surface when someone manually `npm test`-ed.

Fix landed in `d98de44`: 4th CI job `web` runs `npm install --no-audit --no-fund && npm run build && npm test`. Initial `npm ci` choice was wrong — vitest 4 nests its own vite which pulls esbuild ^0.27 while top-level vite 5 pins esbuild 0.21. Mac-generated lockfile captures only top-level → `npm ci` strict bails on Linux. Documented the choice in the workflow comment so future-me doesn't switch it back.

Smoke scripts (anti-snipe / snapshot-fallback / catchup / schema / 401) **deliberately NOT wired** — they need docker-compose stack and the runtimes are ~12s / ~30s, both need parallelization before they're worth CI minutes. Tracked as known gap.

Verdict from Elia: LGTM ✅. Approved, merged via @PDGGK.

### #66 README overhaul — merged

PDGGK's bilingual README + §15 CI claim. After #65 added the `web` job, §15's "frontend tests run in CI" claim became accurate. Posted parity ping; both merged within the same hour. No conflicts.

### #62 dev-log T6 — rebased + merged

PDGGK had flagged this as blocked-on-main's-gofmt (the pre-existing `verify.go` bug I fixed via the T6 stack). After main healed, rebased the docs-only PR onto current main → CI green → merged. The branch was stuck purely on the upstream issue.

### #56 ratified + closed; #58 + #61 closed as deferred

3-way consensus on the design-comparison: A canonical / B generated-and-CI-diff-gated / C archived + port only `?tweaks=1`. Closed #58 (Max Bid stretch RFC, 0 engagement, off demo path) and #61 (evidence verify semantics ratify, no votes after 2 days → leaned passive per my opening recommendation).

### #68 token-extract-ci + #69 tweaks-panel-port — both opened, approved, merged

The two actionable items from the #56 ratify, both shipped same-day:

- **#68** — `apps/web/scripts/extract-design-tokens.mjs` (108 LOC) parses `:root` blocks in `styles.css`, emits sorted JSON + re-emittable CSS artifact. `npm run tokens:check` in the `web` job fails CI if `styles.css` drifts without regenerating. 35 tokens captured across 6 groups; CI gate verified locally (force a diff → exit 1).
- **#69** — `?tweaks=1` dev-only state forcer panel. Mounts at root in App.jsx; gate at `?tweaks=1` → fixed bottom-right panel with controls for status / remainingMs / connStatus / extendCount / currentCents. Direct `setState` (bypasses reducer) is intentional and commented — the goal is "force this UI state for demo capture," not "simulate the wire event." Aesthetic stays mono-neutral; explicitly does NOT adopt the C prototype's Space Grotesk / lava-orange.

Both got substantive LGTMs from Elia. The token-extract validation regex tracked drift cleanly (`padEnd(40)` cosmetic note; postcss upgrade is a 5-line follow-up only if multi-line CSS values appear). Tweaks panel had 4 LOW nits (React.lazy for prod bundle / `STATUSES` should import `AuctionStatus` enum / TIME_PRESETS magic numbers want inline comments / extendCount reset visual symmetry) — all bundled into a single deferred `fari/T6-tweaks-panel-polish` follow-up rather than re-touching an approved branch.

### @PDGGK's #67 (T7 backend rules in ROOM_SNAPSHOT) merged

PDGGK independently shipped my [#60](https://github.com/Eliaaazzz/live-auction-system/issues/60) ask: extend `RoomSnapshotData` with `rules.{stepCents, capCents, reserveCents, maxExtensions, antiSnipeWindowMs}`. Hidden test added to my `auction.test.js`: `applies nested rules without losing capCents=null`. Clean addition — the frontend's `stepCents='500000'` defensive default in store is still there but is now mostly cosmetic since real snapshots ship the value.

## T7 sprint — three of five §4 sub-items landed (5/28)

@Eliaaazzz opened [#70](https://github.com/Eliaaazzz/live-auction-system/issues/70) tracking T7 with 5 sub-items: §4.1 Doubao VLM + SSRF (PDGGK), §4.2 LLM 4-trigger + guardrail (PDGGK + me), §4.3 AI offline badge (me), §4.4 ai-events schema contract test (Elia), §4.5 `make e2e-ai-offline` (me). Per the parallelization plan: §4.3 is independent of everything; §4.5 depends on §4.3; §4.2 is blocked on §4.1 + §4.4.

I took the unblocked items (§4.3 + §4.5) immediately. Took §4.2's wire-and-sidecar half (the back-end trigger-detection hooks remain as a follow-up).

### §4.3 — AI offline badge ([#71](https://github.com/Eliaaazzz/live-auction-system/pull/71), merged)

Architecture: **CustomEvent emitter pattern**, same shape as the existing `lumen:session-expired` from PR #51's 401 wiring. `lib/api.js draftFacts()` wraps the wire call and dispatches `lumen:ai-sidecar-ok` (success) or `lumen:ai-sidecar-offline` (failure) with status/code in detail. `main.jsx` bridge subscribes and routes events → Zustand store actions. No direct store import from `lib/api.js` — keeps the wire layer free of UI coupling.

3 surfaces flip when offline: `<AIBubble>` (offline variant), AdminVLMFacts header pill (neutral gray + a "facts can still be confirmed manually - freeze is unaffected" subtext), LiveRoomRoute `aiStatus` prop. Bid path is **never** gated — TC-T7-301 explicitly pins V9 P3: after `setAiOffline()` a regular `BID_ACCEPTED` envelope still updates `currentCents`/`winnerId`/`totalBidsCount`/`leaders` exactly as it would when AI is OK.

8 new Vitest cases (5 store + 3 api event-dispatch). Verdict from Elia: LGTM with one HIGH (active health-poll missing — solved by cross-PR coordination with #74, see below) + medium deferred (`degraded` middle state for future) + 3 LOW.

### §4.5 — `make e2e-ai-offline` chaos gate ([#72](https://github.com/Eliaaazzz/live-auction-system/pull/72), merged)

`docker compose stop ai-sidecar` → `make e2e-dummy-bid` (must exit 0, V9 P3 invariant) → `docker compose start ai-sidecar` → wait for `/healthz` on `:8090` → `make e2e-dummy-bid` again (recovery). Wired into the existing CI `e2e` job — no new minutes, same teardown.

**Self-review caught a bug** before Elia did: the healthz curl pointed at `:8081`, not the actual `SIDECAR_ADDR=:8090` per `infra/docker-compose.yml`. The original CI passed BY COINCIDENCE — lumen's `depends_on: ai-sidecar` uses `service_started` not `service_healthy`, so the wrong-port healthz check fell through silently and the recovery phase happened to work. Wrong port would have left the chaos gate inactive on every future failure. Caught + fixed (`fa8ab75`) before any reviewer saw it.

Elia's review then surfaced **2 anti-false-green nits** I'd missed:
1. Phase 1 didn't actually assert sidecar was down — `docker compose stop` exits 0 even on container-name typo. Added 5-second post-stop healthz probe; hard FAIL if sidecar still responds.
2. Recovery loop fell through silently when sidecar didn't come back. Added `recovered=0` flag + post-loop `[ "$recovered" != "1" ] && exit 1`.

Both nits move the gate from "test passes when nothing's wrong" to "test passes when both conditions are positively observed." Same shape as the existing MySQL healthz wait in CI.

### §4.2 — LLM auctioneer wire ([#74](https://github.com/Eliaaazzz/live-auction-system/pull/74), merged)

Bigger scope. Ships:
- `apps/ai-sidecar/internal/auctioneer/` Go package (155 LOC + 175 LOC tests) — pluggable `Generator` interface (MockGenerator returns canned-but-trigger-aware text using `WinnerDisplayName`; real Doubao swap is 1-liner) + `generateWithGuardrail` shared core
- Guardrail: length ≤ 80 runes (NOT bytes — Chinese-char-friendly), URL regex (`(?i)\b(https?://|www\.)\S+`), phone regex (CN mobile + `+86` intl), money regex (`(¥|\$|元)\s*\d`), 6 banned marketing claims ("absolute lowest price" / "only one in existence" / "tenfold refund if fake" / "guaranteed authentic" / "100% genuine" / "buyback at original price"). Returns `(reason string, bad bool)` so sidecar log captures *which* rule fired.
- Fallback canned per-trigger text on generator error OR guardrail violation. Sidecar always returns valid `Response` — backend doesn't need to handle "AI failed" specially.
- Frontend reducer for `AUCTIONEER_TEXT` event: 3 store fields (`auctioneerText`/`Trigger`/`Fallback`) + LiveRoomRoute reads + heuristic fallback when no broadcast yet. `seq: null` exempts from seqguard per spec.
- **V9 P3 regression test**: AUCTIONEER_TEXT applied AFTER a seeded BID_ACCEPTED — assert `status`/`currentCents`/`lastSeq`/`totalBidsCount` ALL unchanged.

11 Go tests + 7 frontend tests, 137/137 green.

#### Naming conflict with @Eliaaazzz's parallel #73

While #74 was in review, Elia opened [#73](https://github.com/Eliaaazzz/live-auction-system/pull/73) — the §4.4 schema contract PR — using different names for the same wire surface:

| Field | My #74 (impl) | Elia's #73 (spec) |
|---|---|---|
| Event type | `AUCTIONEER_TEXT` | `AI_COMMENTARY` |
| Endpoint | `POST /auctioneer` | `POST /llm/auctioneer` |
| Trigger | `jump` | `surge` |
| Response field | `text` | `commentary` |
| Fallback flag | `data.fallback: bool` | not specified |

Per #70 §5 ("contract first: §4.4 should land before §4.1 so §4.1 has an oracle to verify against"), the spec PR is the source of truth. I posted [coordination comments](https://github.com/Eliaaazzz/live-auction-system/pull/73#issuecomment-4555089924) on both: #74 ships with my names + when #73 lands, I rebase + 5-way rename pass. Elia accepted (spec ownership was already settled by the #73 reconciliation) and approved #74 as-is.

Memory updated: [`feedback-lumen-contract-pr-first`](https://github.com/Eliaaazzz/live-auction-system/blob/main/docs/dev-log/2026-05-28-fari-t7-sprint.md) — when a spec PR and implementation PR cover the same contract surface, let the spec ratify first; the implementation rebases onto it. Mechanical churn that the alternate order would have avoided.

#### Cross-PR coordination — AUCTIONEER_TEXT flips aiSidecarHealth back to 'ok'

Elia's #74 review surfaced an H2 that elegantly solves #71's H1: the `AUCTIONEER_TEXT` event itself is proof the sidecar is alive. Adding one line to the reducer case (`next.aiSidecarHealth = 'ok'`) means the buyer view (which never calls `draftFacts`) doesn't get stuck at a stale 'offline' badge. Avoids needing a separate `/api/ai/health` polling endpoint.

Done in the rebase. Test pinned (`cross-PR #71↔#74: AUCTIONEER_TEXT flips aiSidecarHealth back to "ok"`). The same coordination idea solved #71's deferred H1 without shipping the active-poll follow-up.

### #73 review — what I caught Elia's spec missed

Substantive review on Elia's contract PR (returning the rigor — fair, since he reviewed mine deeply). [1 BLOCKING + 3 nits + 4 hidden tests](https://github.com/Eliaaazzz/live-auction-system/pull/73#issuecomment-4555094521):

- **B1 — Currency regex too narrow vs §2.4 stated intent**. Spec says "prevent commentary from naming alternative prices," but the regex is `¥\s*\d` — doesn't catch a yuan-suffixed price such as "starts at 1000 yuan" or `worth $500 USD`. A prompt injection asking the model to mention a 50000-yuan price leaks straight through. Mine #74 already catches all three (`(¥|\$|元)\s*\d`). Suggested widening + 2 test cases.
- **M1** — `AI_COMMENTARY` envelope spec doesn't include `data.auctionId`. Every other server→client envelope ships it; multi-tab open in different auctions can't differentiate without it.
- **M2** — `data.fallback` flag UX decision pending. Either render fallback differently (dim, virtual-border) so user can distinguish "AI was here" from "AI failed," OR explicitly choose identical-render. Mine ships the flag; happy to drop if `#73 decides no-flag.
- **L1** — canned fallback strings (4, one per trigger) not yet enumerated in spec. Worth pinning so they're individually reviewable (a banned-word fallback that itself contains a banned word would be embarrassing).
- **L2** — `surge` 5s debounce + `cold` 30s suppression — spec doesn't say where the debounce state lives (per-process? per-auction in Redis?). Worth clarifying so backend hook implementer knows whether it survives a restart.
- **Hidden tests** (worth adding to #73's TC list): a yuan-suffixed amount should fail; a USD market price such as `$300` should fail; surge context missing `bidsLast5s`; sidecar returns both `commentary` AND `text` field (forward-compat collision).

Awaiting Elia's reply.

## Cleanup pass — old issues + stalled PRs

**#32 T3 follow-up audit** — code-verified that the P1 (`handleCancel` TOCTOU) and P2 (`hammerDue` ERR_INTERNAL retry loop) are both already fixed in main. `apps/lumen/internal/server/api.go:334` uses `UpdateAuctionStatusIf` with explicit `expected = StateDraft`; `timer.go` has the explicit `case model.CodeErrInternal:` that untracks + emits one ERROR. Posted [closure recommendation](https://github.com/Eliaaazzz/live-auction-system/issues/32#issuecomment-4555127152); remaining P2/P3 items are T8 perf/docs work better tracked alongside T8 PRs.

**#37 T4 follow-up** — audited similarly. Items (`VerifyEvidenceChain` caching, HMAC key rotation, JSON normalization on MySQL upgrade) are all genuinely still open and appropriately deferred to T8 / post-MVP. Issue stays open.

**#18 + #24 + #46 rebases** — all three CHANGES_REQUESTED PRs had my fix follow-ups already in but Elia hadn't re-reviewed. Rebased each onto current main:
- #46 (dev-log T4/T5): 2 commits replayed cleanly → APPROVED + merged today
- #24 (chaos-runner T9 skeleton): 5-commit chain, no conflicts → CI green, awaiting Elia re-review
- #18 (observability T8 prep): Makefile `.PHONY` conflict (main has `verify-evidence`, branch has `up-obs`) — resolved kept both → CI green, awaiting Elia re-review

## Stack state going into next session

| PR | State | What it does |
|---|---|---|
| Merged today | | |
| #46 | ✅ main | dev-log T4/T5 |
| #62 | ✅ main | dev-log T6 |
| #71 | ✅ main | T7-3 AI offline badge |
| #74 | ✅ main | T7-2 LLM auctioneer wire + sidecar |
| #72 | ✅ main | T7-5 `make e2e-ai-offline` |
| Open · awaiting Elia re-review | | |
| #18 | rebased + CI green | T8 perf prep (Prometheus + Grafana) |
| #24 | rebased + CI green | T9 chaos-runner skeleton |
| #73 | reviewed substantively | Elia's §4.4 contract — awaiting his reply on B1 |

T7 remaining: §4.1 (PDGGK Doubao VLM), §4.4 (Elia #73), §4.2 backend trigger hooks (PDGGK + me, once #73 ratifies the wire names).

## Deferred (honest)

- **§4.2 backend trigger detection hooks** — actual condition checks in lumen for `open` (AUCTION_START) / `surge` (BID_ACCEPTED ≥ 3·step) / `cold` (lastBidAtMs >30s) / `hammer` (AUCTION_SOLD). Sidecar `/auctioneer` endpoint exists + frontend reducer ready, but no backend currently calls sidecar. Frontend will render any `AUCTIONEER_TEXT` event the backend broadcasts — the wire is alive except for the detector. Half scope, clean follow-up after #73 ratifies names.
- **TC-T7-204** (cold trigger no double-fire on LIVE→SOLD transition) — backend-hook-only, not in #74's scope.
- **Active `/api/ai/health` polling** — solved by the cross-PR coordination (AUCTIONEER_TEXT proves sidecar alive) for buyer view; AdminVLMFacts still relies on draftFacts signal. Acceptable for demo.
- **`fari/T6-tweaks-panel-polish`** — 4 LOW nits from Elia's #69 review (React.lazy / AuctionStatus enum / TIME_PRESETS comments / extendCount reset symmetry). Bundle into one PR; no urgency.
- **#73 H1 (active poll) + L1 (canned fallback strings in spec)** — Elia's call.

## Lessons / reflections

1. **Self-review caught two bugs Elia would have caught**: AbortError leaked offline-badge stickiness in #71 (route unmount mid-request → fetch throws AbortError → wrapper flips badge to offline even though sidecar is fine); chaos gate port mismatch in #72 (`:8081` vs actual `:8090`). Same self-review pass methodology as 5/26: pull the branch, run it, *list every assumption* and verify each. Found both before pushing. **That methodology stays — it's the only thing that catches "the bug your tests pass through silently."**

2. **Naming conflict with #73 was avoidable**. I should have either (a) posted "I'm using `AUCTIONEER_TEXT`/`/auctioneer` — Elia, please confirm or push back" on #70 before writing code, or (b) waited for #73 to ratify. Did neither; ate the rename cost. Memory updated; the contract-PR-first pattern is now load-bearing in my mental model.

3. **Cross-PR coordination is a review-time discipline**. Elia's H2 on #74 ("AUCTIONEER_TEXT proves sidecar alive — flip aiSidecarHealth in the reducer") was a one-LOC insight that eliminated my entire active-poll follow-up plan. Worth asking during EVERY PR review: "what observable signal does this PR produce that ANOTHER PR could subscribe to?" Same question would surface the same answer earlier next time.

4. **Old-issue audit pays off**. Two issues (#32, #37) had P1 items I'd raised weeks ago. Code-checking each line by `grep -n UpdateAuctionStatusIf` / `grep -n CodeErrInternal` took 5 minutes and found that #32's P1+P2 were already fixed silently in some prior PR. That's a clean close — issues that drift open after their fix lands clog the backlog. Next time: audit each old issue on its anniversary.

5. **Test-as-gate vs test-on-disk** (Elia's B1 framing) is the right axis to measure test infrastructure work. 114 Vitest cases that nobody runs in CI is decorative; same 114 cases wired to a CI step that fails the merge is load-bearing. The 10 lines of yaml are the highest-ROI change in the entire test suite PR — Elia caught it because his mental model evaluates test infra by "what does it prevent from merging."

---

**Refs**:
- T6 sealing: #65 (test suite + CI gate), #66 (README overhaul), #62 (dev-log T6), #56 (design ratify, closed), #58/#61 (closed deferred), #68 (token-extract), #69 (tweaks panel), #67 (T7 backend rules from PDGGK)
- T7 work today: #70 (tracking issue), #71 (T7-3), #72 (T7-5), #74 (T7-2)
- Coordination: #73 (Elia's §4.4 — reviewed substantively, awaiting reply)
- Cleanup: #32 (P1+P2 audit + closure recommendation), #18 / #24 / #46 (rebased)
- Memory: `feedback-lumen-contract-pr-first` (today's lesson)
- Tomorrow's targets: address @Eliaaazzz's #73 B1, watch for §4.1 + §4.4 ratify, then unblock §4.2 backend trigger hooks
