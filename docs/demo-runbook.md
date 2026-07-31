# Demo Runbook (T10)

> **3-minute full-chain demo** for the ByteDance Douyin E-commerce AI Full-Stack
> challenge. The governing rule (V9 §4.4): **every demo node has a corresponding
> `make` verification command** — the demo is an *assertable path*, not a screen
> recording. The single source of truth for the path is `make demo`
> (`Makefile`); this doc is the human script + fallback plan wrapped around it.
>
> - Internal freeze: **2026-06-08** · Rehearsal (incl. fallback): **2026-06-09** · D-day: **2026-06-10**
> - Owners: **@PDGGK** (public deploy · narration · backup recording · product/demo lens) · **@fariZzzz** (`make demo` orchestration · verifier/load/chaos evidence · this runbook)

---

## 0. One command

```bash
make demo      # full §12 path, leaves the stack up so you can show the UI
make down      # tear down when finished
```

`make demo` runs every §12 node in order and is green **iff** the whole path
holds — each sub-target exits non-zero on any failed assertion and `make` aborts
on the first failure, so a partial path can never report success. That green run
is the T10 exit evidence ("3-min demo path = e2e suite green").

For a fast wiring check (small N, no 500/50 wall-clock): `make demo-smoke`.

---

## 1. The path (V9 §12)

Each row: the on-screen moment, the **narration**, the **`make` command
that proves it**, and the assertable signal to point at.

| # | On-screen | Narration | `make` verification | Assert / what to point at |
|---|---|---|---|---|
| 1 | Seller uploads product photos, the VLM extracts facts | "AI extracts brand/condition/flaws, and high-risk fields are labelled 'seller statement, not verified by AI'" | `make e2e-dummy-bid` (step: facts draft + factsConfirmed gate) | `highRiskFieldsDisclaimer` present; create-auction **forbidden** until confirmed |
| 2 | Seller confirms/edits facts and sets rules | "Start price / bid increment / duration / anti-snipe window — the seller gives the final endorsement" | same e2e (freeze → `CodeOKFrozen`) | freeze returns `OK_FROZEN`; rules locked |
| 3 | Auction starts, many viewers bid live, AI commentary bubbles up | "Four triggers — start / price jump / 30s of silence / hammer — and AI is a sidecar, never an adjudicator" | same e2e (start → `OK_LIVE` → multi-WS bid → broadcast) | bidder **and** observer both get `BID_ACCEPTED` |
| 4 | Anti-snipe in the final N seconds, countdown extends | "A bid at the last moment extends the clock automatically — anti-sniping" | `make demo-auction` (+ UI live) | two `AUCTION_EXTENDED` (`extendCount` 1→2, bounded by `MaxExtensions`) |
| 5 | Hammer → evidence card | "A sale immediately produces an evidence card: photo / price / timeline + `events_hash`" | `make demo-auction` (→ `AUCTION_SOLD` + `eventsHash`) · `make verify-evidence` | demo-auction asserts hammer + non-empty `eventsHash`; verify-evidence: exit 0, no `hash_break` |
| 6 | Replay Verifier consistent | "Stream / Redis / MySQL agree three ways, plus the hash-chain check" | `make verify` | `consistent`; no `mismatch_at_seq` / `hash_break_at_seq` |
| 7 | Monitoring dashboard at 500/50 | "500 online + 50 actively bidding, ack/broadcast p95 within budget, **seq gap = 0**" | `make load` | p95 within §4.2 budgets; `seqGapCount=0`; post-load verify consistent |
| 8 | Five 30s chaos drills | "MySQL/WS/Timer/AI/Redis each go down for a while, proving degradation and self-healing" | `make chaos` | 5× `CHAOS_OK` + `✓ T9 PASSED · 5/5`; bidding continues while AI is down (V9 P3) |

> `make demo` runs all of it automatically: nodes 1–3 (`e2e-dummy-bid`), **4–5
> (`demo-auction`: anti-snipe extend → hammer → evidence)**, 5 (`verify-evidence`),
> 6 (`verify`), 7 (`load`), 8 (`chaos`). Every node is now an assertion — node 4
> is no longer UI-only (see §3).

---

## 2. Three-minute script

Pre-flight (before the clock): `make up && make seed` so the stack is warm.
Open two tabs: `/admin` (seller console) and `/room/auc_demo` (buyer room) — the
designed React app, served by lumen at `http://localhost:8080`.

| Time | Screen | Narration points |
|---|---|---|
| 0:00–0:30 | admin: upload photo → VLM facts → confirm → set rules → start | Nodes 1–2: AI extraction + seller endorsement + rules frozen |
| 0:30–1:15 | room: bids from several clients, price odometer + leaderboard flight + AI bubbles | Node 3: the live bidding atmosphere; stress that AI is a sidecar |
| 1:15–1:35 | room: late-stage anti-snipe, countdown `+Ns`, the `extendCount` badge | Node 4: anti-sniping is a differentiating highlight |
| 1:35–2:00 | hammer → evidence card, expand the hash chain; switch to the terminal for `make verify-evidence` / `make verify` | Nodes 5–6: a trustworthy sale + three-way consistency |
| 2:00–2:35 | Grafana panel: 500/50, p95, seq gap=0; the tail of `make load` in the terminal | Node 7: the system under engineering load |
| 2:35–3:00 | The chaos-drill cut (5×30s) or the tail of `make chaos`; close on AI down while bidding continues | Node 8 + V9 P3: resilience as the closing note |

Keep a terminal visible running `make demo` in parallel — the scrolling
`CHAOS_OK` / `✓ ... PASSED` lines are the "not a mockup" proof judges respond to.

---

## 2.5 Innovation cutaway · #114 modes (optional, 20–30 seconds)

The main 3-minute path should stay focused. If the judges ask "what is the
innovation beyond English auction?", use a short cutaway backed by `make demo-smoke`:

```bash
make demo-sudden-death
make demo-sealed
make demo-vickrey
make demo-hybrid
make demo-allpay
make demo-prequalify
```

Narration points:

- **Sealed / Vickrey**: hidden bids stay private during LIVE, then reveal atomically at close.
- **HYBRID_REVEAL**: the room sees runner-up pressure, while the true leader is hidden until SOLD.
- **ALL_PAY**: show only as a **virtual coin event** — say explicitly that it is **virtual coins, not a real payment, and not gambling**. The evidence card exposes `settlement: "VIRTUAL_COINS_ONLY"`, and the backend verifier asserts there are zero normal `orders` rows.
- **PREQUALIFY**: a sealed parent seeds the formal auction's start price through `/spawn-formal`.

This cutaway is optional for timing, but the commands are not hand-wavy: every mode
demo asserts its own state/event/evidence invariant.

---

## 3. Anti-snipe (node 4)

`e2e-dummy-bid` does a single bid and exits before the timer, so it does **not**
drive an `AUCTION_EXTENDED`. That gap is now closed by **`make demo-auction`**
(`RunDemo`, `apps/lumen/internal/server/demo.go`) — the assertable form of demo
nodes 4–5:

1. starts a **short** auction whose anti-snipe window ≥ its duration, so the
   whole auction sits inside the window and any accepted bid extends
   deterministically (no flaky "land a bid in the last N seconds" timing);
2. bidder A bids → asserts `AUCTION_EXTENDED` with `extendCount == 1`;
3. bidder B (a competing snipe) bids → asserts `extendCount == 2`, bounded by
   `MaxExtensions=2`;
4. stops bidding → the Timer Worker hammers → asserts `AUCTION_SOLD`;
5. fetches the evidence card → asserts a non-empty `eventsHash` (chain head).

Prints `DEMO_AUCTION_ID=… · demo-auction: PASS · extendCount=2 → AUCTION_SOLD → eventsHash=…`.
Wired into `make demo` / `make demo-smoke` as node 3.

- **Live (preferred for narration):** in `/room/auc_demo`, place a bid inside the
  anti-snipe window — the countdown extends and the `extendCount` badge bumps.
  Most legible on camera; `make demo-auction` is the proof it actually fired.
- The timer + boundary behavior is *also* independently covered by
  `make chaos-timer` (LIVE outlives `endAtMs` when the timer is disabled; hammers
  to `SOLD` when re-enabled).

---

## 4. Fallback ladder

Rehearse **all three** on 2026-06-09. Never debug live — drop one rung.

1. **Public deploy** (primary) — `<DEPLOY_URL TBD · @PDGGK>`. Pre-checks: health
   endpoint green, seed run, one manual bid 10 min before.
2. **Local Docker** (rung 2) — `make demo` on the presenter's laptop. This is
   why the path is `make`-driven: the exact same assertions run offline. Have the
   stack pre-warmed (`make up && make seed`) so cold-build time isn't on camera.
3. **Backup recording** (rung 3) — pre-recorded full run + the 5 chaos clips (see
   §5). Play if both network and laptop fail.

Decision rule: if the primary isn't green at **T-10 min**, present from rung 2;
if rung 2 isn't green at **T-2 min**, play rung 3. No live debugging on stage.

---

## 5. Backup recording shot list (@PDGGK)

Pre-record so rung 3 is complete (each is independently playable):

- [ ] Full §12 path (admin → room → evidence card), ~3 min, clean audio
- [ ] #114 mode cutaway: sealed reveal, Vickrey second-price, HYBRID hidden leader, ALL_PAY virtual-coin marker
- [ ] `make chaos` terminal run (or 5× 30s clips: ai / redis / mysql / ws / timer) showing `CHAOS_OK` + self-heal
- [ ] `make load` + Grafana panel: 500/50, p95, **seq gap = 0**
- [ ] Evidence card hash-chain expand (`prev_hash → curr_hash`, first 8 hex)
- [ ] ALL_PAY evidence marker: `settlement: "VIRTUAL_COINS_ONLY"` / "virtual coins, not a real payment, not gambling"
- [ ] AI-offline moment: the badge flips to "the auctioneer has stepped away" and bidding continues (V9 P3)

---

## 6. Pre-demo checklist

- [ ] `make demo` green on the presenter laptop (full path) — **2026-06-09**
- [ ] CI green for the demo atoms (`e2e-ai-offline`, `chaos-smoke`, `load-smoke`, frontend smokes); run `make demo-smoke` locally if wrapper-order confidence is needed
- [ ] Public deploy health-green + seeded + one manual bid (T-10 min)
- [ ] Optional coalescing visibility check: set `ROOM_STATE_PATCH_MIN_VIEWERS=10` for a small judge room (or `1` locally), restart lumen, and confirm a `ROOM_STATE_PATCH`; keep the default `1000` for production-scale wording
- [ ] Backup recording + 5 chaos clips on local disk (not only cloud)
- [ ] Grafana panel bookmarked + datasource live (`infra/grafana`, `infra/prometheus`)
- [ ] Two browser tabs pre-opened (admin + room), sound on for AI/auctioneer audio
- [ ] #114 mode cutaway rehearsed, especially the ALL_PAY compliance wording
- [ ] `AI uses Doubao, demo runs mock` line ready (the key was deprovisioned; mock path is honest + reproducible)
