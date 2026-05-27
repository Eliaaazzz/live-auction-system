# `tools/chaos-runner/` — fault-injection orchestrator + assertion harness

> **T9 territory** (V9 §10 + §4.4 — "5 fault drills with assertable logs, not just videos"). Off-trunk vs T1 (PR #19) so this PR doesn't conflict with the leader's path. AI phase implemented end-to-end as the safest first drill; other 7 phases are stubbed with full design specs in `internal/phases/stubs.go`.

Per [PR #21 diagram #8 "Delivery Ownership and Evidence Map v4"](https://github.com/Eliaaazzz/live-auction-system/blob/pdggk/arch-diagrams-v4/docs/architecture/v4/), the chaos-runner lives under the **Operator/QA** column → **five fault videos** evidence column. This skeleton lays the runtime so the videos *plus* the machine-readable artifacts both come for free.

---

## Phase taxonomy: standard + diversification

Per V9 §4.4, the rubric expects 5 fault drills. This skeleton ships the 5 standard phases (only AI implemented end-to-end so far) **PLUS proposes 3 additional phases** that close real gaps in the standard set.

The 3 additional are **discussion points, not silent expansion** — they ship as stubs with full spec in `internal/phases/stubs.go` so the team can ratify per-phase before implementation work lands.

### Standard 5 (V9 §4.4)

| Phase | Kind | Inject | Expected degrade | Recovery deadline |
|---|---|---|---|---|
| `ai` ✅ | process_kill | SIGTERM ai-sidecar container | none (bid path unaffected per V9 §0) | 30s |
| `redis` | network | toxiproxy disable / timeout | `ERR_AUCTION_PAUSED` per V9 §0 boundary 7 | 10s |
| `mysql` | network | toxiproxy disable | none (off hot path) | 30s |
| `ws` | process_kill | SIGKILL gateway (T1 = `lumen`) | none in T1 single-gateway (existing conns drop, reconnect handles); T5+ multi-gateway shows seamless catchup | 5s |
| `timer` | process_kill | SIGKILL timer subcommand | none in window; auctions pending expiry queue up | 10s |

### Diversification 3 (this PR proposes)

| Phase | Kind | Why it's worth adding |
|---|---|---|
| `slowclient` | client | **V9 §0 boundary 8 (bufferedAmount 1MB/4MB) is currently *claimed* not *verified*.** Standard 5 don't include any client-side stress drill — there's no recording of "fast clients unaffected by slow client" in V9. This phase makes that claim measurable: spawn 1 slow consumer + 10 fast bidders, prove fast clients' ack p95 stays within envelope, force-close at 4MB triggers. |
| `schrodinger` | network | **Gap-zone case the standard `redis` phase misses.** Standard `redis` phase = Redis fully down → `ERR_AUCTION_PAUSED` fires + RedisDown alert. But the *worse* case is Redis up-but-slow: 500ms per command, no `ERR_AUCTION_PAUSED`, RedisDown alert silent. Detection has to come from the ack-latency-above-floor SLO breach. This phase is the positive proof that the dashboard alerts catch it. |
| `tamper` | data | **The hash chain claim isn't decorative IF we prove tamper triggers detection.** Standard 5 don't include any positive-proof drill for the integrity layer (PR #16 challenge #3 hash-chain locus). Flip one byte in MySQL `auction_events.event_hash` → verify `make verify` exits 2 with `hash_break_at_seq=N`. Without this drill, the V9 §6 evidence card "integrity check" wording is unverified marketing copy. |

### Stretch (P2, deferred)

- `halfpartition` — gateway↔Redis OK but gateway↔bid-engine NOT OK. Tests the post-T5 multi-process topology degrades correctly. Not in scope until T5 splits processes.

---

## CLI

```bash
chaos-runner \
  --phase ai \
  --duration 5s \
  --recover 30s \
  --target-aid auc_demo \
  --bid-rate 5 \
  --out docs/demo/chaos-recordings/
```

Exit codes:
- `0` — drill ran, all invariants passed
- `1` — drill ran, ≥1 invariant failed (this is *real evidence*, the system did the wrong thing — investigate)
- `2` — unknown/unrecognized phase
- `3` — orchestrator internal error (couldn't reach lumen, docker compose unavailable, etc.)
- `78` — known phase but not implemented in this skeleton (use as CI signal to expect this PR's stubs)

---

## Invariants (all phase-agnostic + per-phase additions)

| Invariant | What it checks | Phases that get it |
|---|---|---|
| `seq_no_gap` | seq advances monotonically by 1 across the drill window (pre + accepted + terminal = post) | all |
| `recovery_within` | first `OK_ACCEPTED` after uninject within phase's `RecoveryDeadline` | all |
| `verifier_consistent_after_drill` | post-drill `make verify --mode settled` exits 0 | all |
| `latency_envelope_during_drill` | during-drill bid p50/p95/p99 within phase tolerance (200ms default; wider for network phases) | all |
| `degrade_expected_codes_seen` | during-drill bid attempts include ≥1 of phase's `ExpectedDegradeWireCodes()` | only phases that declare expected codes (e.g. `redis` → `ERR_AUCTION_PAUSED`) |

The `latency_envelope` invariant is **new beyond V9 §9** — it's the quantitative version of "system held up under chaos". The standard phrasing is binary ("bidding continued"); this records the latency distribution so demo evidence is "bidding continued AND p95 stayed under 200ms during the drill", not just the qualitative claim.

---

## Artifact format

Each drill emits `docs/demo/chaos-recordings/chaos-run-<phase>-<timestamp>.json`:

```json
{
  "phase": "ai",
  "auction_id": "auc_demo",
  "injected_at": "2026-06-05T10:30:00Z",
  "uninjected_at": "2026-06-05T10:30:05Z",
  "pre_snapshot":  {"seq": 423, "status": "LIVE", ...},
  "post_snapshot": {"seq": 489, "status": "LIVE", ...},
  "bids": [
    {"at": "...", "code": "OK_ACCEPTED", "duration": "42ms"},
    ...
  ],
  "accepted_count": 66,
  "terminal_count": 0,
  "reject_code_counts": {"ERR_AUCTION_PAUSED": 0},
  "first_ok_after_uninject": "...",
  "invariants": [
    {"name": "seq_no_gap", "passed": true, "message": "..."},
    {"name": "recovery_within", "passed": true, "message": "..."},
    {"name": "verifier_consistent_after_drill", "passed": true, "message": "..."},
    {"name": "latency_envelope_during_drill", "passed": true, "message": "p50=15ms p95=42ms p99=88ms within tolerance 200ms (n=66)"}
  ],
  "all_invariants_passed": true
}
```

These JSON files are the **assertable** evidence per V9 §9. The PR #18 chaos dashboard (`infra/grafana/dashboards/chaos.json`) consumes the `lumen_chaos_active` gauge for live state; the per-drill JSON is the post-hoc audit trail.

---

## Architecture

```
cmd/runner/main.go              CLI flag parsing → orchestrator.Run
internal/
├── orchestrator/
│   ├── orchestrator.go         Lifecycle: pre-snap → inject → drive → uninject → recover → post-snap → invariants → artifact
│   └── bidgen.go               Background steady-bid generator (records every attempt + latency)
├── phases/
│   ├── phase.go                Phase interface + Lookup(name) + AllNames()
│   ├── ai.go                   ✅ AI sidecar SIGTERM via `docker compose kill`
│   └── stubs.go                Specs (not impls) for the other 7 — Lookup returns ErrNotImplemented
├── invariants/
│   ├── invariant.go            Invariant interface + per-phase selection via For(phaseName)
│   ├── seq_no_gap.go           ✅ V9 §4.1 zero-tolerance
│   ├── recovery.go             ✅ First OK_ACCEPTED after uninject within deadline
│   ├── verifier_consistent.go  ✅ Shells out to `make verify` post-drill
│   ├── latency_envelope.go     ✅ NEW — quantitative SLO during chaos
│   └── degrade.go              ✅ Expected wire codes seen during drill
└── artifact/
    └── artifact.go             Recorder (thread-safe) + Write JSON
```

---

## Known gaps (PR #24 CR follow-up status)

1. ~~Bid generator drives REST not WS~~ — **FIXED** (PDGGK PR #24 CR 🔴 #2). `steadyBidder` now dev-logins → opens WS → `ROOM_JOIN` → fires real `BID_PLACE` envelopes via gorilla/websocket. Records OK_ACCEPTED on `BID_ACCEPTED`, the wire code on `BID_REJECTED`, `ERR_TIMEOUT` if no ack within 2s, `ERR_WS_READ` if the connection drops. Initial snapshot drives the amount progression (`startPrice + n*increment`). The AI drill now actually proves "AI down → bid acceptance continues" via the real WS hot path.
2. ~~Snapshot URL wrong~~ — **FIXED** (PDGGK PR #24 CR 🔴 #2). `GetSnapshot` now hits `GET /api/auctions/{id}` (T2 route; no `/snapshot` suffix). Pinned by hidden test `TestHiddenGetSnapshotUsesLumenAuctionRoute`.
3. ~~undo called twice on happy path~~ — **FIXED** (PDGGK PR #24 CR 🟠). Orchestrator wraps `rawUndo` in `sync.Once`; explicit happy-path call + defer safety net now collapse to a single execution.
4. ~~Latency envelope passes on zero samples~~ — **FIXED** (PDGGK PR #24 CR 🟠 #3). `LatencyEnvelope` now FAILS if zero samples OR zero `OK_ACCEPTED` recorded — drill can't silently green with broken bidgen. Pinned by 3 hidden tests in `latency_envelope_hidden_test.go`.
5. **4 of 5 standard phases stubbed** (PDGGK PR #24 CR 🔴 #1). Only `ai` is wired end-to-end. `redis`/`mysql`/`ws`/`timer` return `ErrNotImplemented`; specs in `internal/phases/stubs.go`. Toxiproxy compose wiring (PR #24 CR 🟠 #4) is the gate for `redis`/`mysql` to become runnable — follow-up PR.
6. **3 diversification phases (`slowclient`/`schrodinger`/`tamper`) remain proposed probes**, not part of V9 acceptance set. Per PDGGK CR: "keep the 3 NEW probes only if they do not displace the standard five recordings."
7. **Verifier/tamper claims are ahead of trunk** (PDGGK PR #24 CR 🟡 #5). Current `verify.go` is a count skeleton; hash-chain fields are nullable T4 work. `tamper` phase stays as proposed future probe, NOT a T9 acceptance item.
8. **No `make chaos PHASE=ai` target yet.** Follow-up with Toxiproxy compose wiring.

---

## Sign-off needed

This PR is asking the team to ratify:

1. **The taxonomy: 5 standard + 3 diversification + 1 stretch.** If anyone objects to slow-client / schrodinger / tamper as in-scope for T9, they get dropped before implementation. My recommendation: keep all 3 — each closes a real gap in V9 §4.4's binary "fault drill passed/failed" framing.
2. **The artifact JSON schema.** This is what mentor reviewers + future load reports parse. Lock now so dashboards + reports can be built against it.
3. **The 5 invariants.** Especially `latency_envelope_during_drill` — it's new beyond V9 §9. If anyone thinks the quantitative version overclaims, drop to binary.

Per [#15 Workflow v2](https://github.com/Eliaaazzz/live-auction-system/issues/15): @Eliaaazzz leader call on whether T9 work starting this early (we're at T1) is welcome or premature. @PDGGK product/demo lens on whether the artifact JSON shape is demo-visible-enough.
