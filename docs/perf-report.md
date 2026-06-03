# T8 Perf Report — Lumen Auction (V9 §4.2 P0 gate)

> **Status:** template — fill the §1 box-spec & §2 numbers AFTER `make load` runs on the team-deploy box.
> Source instrumentation: `apps/lumen/internal/metrics/`. Source harness: `apps/lumen/internal/server/load.go` (`lumen load`).
> SLO budget: V9 plan §4.2 (`ack p95 < 80 ms · broadcast p95 < 150 ms · hammer p95 < 500 ms · catchup 200 events < 1 s · 500 connected + 50 active, 60 s+ stable`).

---

## 1. Topology + box spec (V9 §4.3 required)

| Field | Value |
|---|---|
| Date | `YYYY-MM-DDTHH:MMZ` |
| Box | `<CPU model · cores · GHz>` · `<RAM>` · `<storage>` |
| OS / kernel | `<linux release>` / `<kernel>` |
| Go | `<go version>` |
| Redis | `redis:7-alpine` · `<config notes — AOF everysec>` · `<maxmemory>` |
| MySQL | `mysql:8` · `<my.cnf notes>` |
| Gateway topology | **1 gateway × 500 connections** (single-instance, matches `--mode=all`). Multi-gateway split is a T5/T9 follow-up. |
| Lumen build | `<git sha>` |
| Harness | `lumen load` (`infra/docker-compose.yml` `load` profile) — defaults below |
| Network | `<host-loopback | overlay>` — same-box compose; no WAN |

Harness defaults (§4.2 P0 gate):
- `LOAD_OBSERVERS=500`
- `LOAD_BIDDERS=50`
- `LOAD_SHARDS=1`
- `LOAD_DURATION_SEC=60`
- `LOAD_BID_INTERVAL_MS=100` (50 bidders × 10/s ≈ 500 bid/s aggregate)
- `LOAD_AUCTION_DUR_SEC=3600` (auction stays LIVE past the window → no hammer in the budget; record `hammerLatencyMs` only when a short-duration follow-up run hammers mid-window)
- `LOAD_OBSERVER_STAGGER_MS=10` (so the upgrade queue doesn't spike ack-p95 with a thundering herd)

---

## 2. Acceptance table (V9 §4.2 gate · 0-tolerance §4.1)

> Fill these from the `make load` stdout (the harness prints a `---- T8 load report ----` block). p95 is reservoir-sampled from `apps/lumen/internal/metrics.Histogram` over the full run.

| Metric | Budget (P0 gate) | Floor (P0 minimum) | Result | Pass/Fail |
|---|---|---|---|---|
| `BID_ACCEPTED` ack p95 | < 80 ms | < 200 ms | `_____ ms` | ⬜ |
| broadcast p95 (Bid Engine → last viewer) | < 150 ms | < 500 ms | `_____ ms` | ⬜ |
| hammer p95 (detection + Lua + fanout) | < 500 ms | < 2 s | `_____ ms` (n=`__`) | ⬜ |
| catchup (200 events) p95 | < 1 s | < 3 s | `_____ ms` (n=`__`) | ⬜ |
| `place_bid.lua` script_time p99 | < 5 ms | — (pre-gate, §4.2 footnote) | `_____ ms` | ⬜ |
| 500 connected + 50 active, 60 s+ stable | required | — | `_____ s observed` | ⬜ |
| seq gap | **0** | **0** | `__` | ⬜ |
| Verifier on post-load auction | `consistent` | — | `__________` | ⬜ |
| AOF fsync stalls observed | none > 50 ms | — | `__` | ⬜ |
| Go GC pauses (p99) | < 10 ms | — | `_____ ms` | ⬜ |

> Hammer SLO note: hammer measurement = `closeDue` detection lag + Lua exec (recorded in `hammerLatencyMs`) **plus** the AUCTION_SOLD broadcast-fanout latency (recorded in `broadcastLatencyMs`). The §4.2 budget is the sum; the report sums them in the P95-additive worst case (`hammer_p95_total ≈ hammerLatencyMs.p95 + broadcastLatencyMs.p95` for AUCTION_SOLD events). Long-duration default auctions never hammer inside the window; a separate `LOAD_AUCTION_DUR_SEC=30` run captures the hammer numbers without competing for the bid window.

---

## 3. Run output (paste-from-stdout)

```text
LOAD_AUCTION_IDS=auc_<...>,auc_<...>
LOAD_AUCTION_ID=auc_<...>
load config: observers=500 bidders=50 duration=60s bidInterval=100ms

---- T8 load report ----
auctions=auc_<...>,auc_<...> elapsed=<...>
topology(harness): observers=500 bidders=50 shards=1 bidInterval=100ms auctionDur=1h
bidder: sent=<N> acked=<N> rejected=<N> errors=<N>
observer: frames=<N> readErrors=<N> dialErrors=<N>
ack       p50=<ms> p95=<ms> p99=<ms> max=<ms> (count=<N>, budget p95<80ms)
broadcast p50=<ms> p95=<ms> p99=<ms> max=<ms> (count=<N>, budget p95<150ms)
hammer    p50=<ms> p95=<ms> p99=<ms> (count=<N>, budget p95<500ms)
catchup   p50=<ms> p95=<ms> p99=<ms> (count=<N>)
script    p50=<ms> p95=<ms> p99=<ms> (count=<N>, budget p99<5ms)
counters: bidsAccepted=<N> bidsRejected=<N> backpressureForceClose=<N> seqGapCount=0 streamLenMax=<N> activeConns(end)=<N>
load: PASS
```

---

## 4. Tune notes (post-run · keep additive)

> Record any per-knob change made to bring a missed budget green. Anchor each change to the metric it moved (so the next runner can reproduce).

- `___ -> ___` because `____` (metric moved from `___` to `___` p95).
- ...

---

## 5. Verifier output (V9 §9 acceptance — must be `consistent`)

```text
consistent: stream=<N> mysql=<N> snapshot_seq=<N> (auction=auc_<...>)
```

If `mismatch_at_seq=...` or `hash_break_at_seq=...` appears: the load was post-load-trimmed past the diff range, or the persistence projection lagged the stream tail. Re-run with a longer settle gap before `make verify`. The MAXLEN trim is currently not enforced by the gateway — guard for T9 chaos.

---

## 6. Stretch / Super-stretch (非 P0 rehearsal)

| Metric | Stretch budget | Result |
|---|---|---|
| ack p99 | < 100 ms | `_____` |
| broadcast p99 | < 300 ms | `_____` |

Run via:
```bash
LOAD_OBSERVERS=1000 LOAD_BIDDERS=100 LOAD_DURATION_SEC=60 make load
```

Super-stretch（100k / 2k / 4-shards）目标：
```bash
make load-100k
```
（如需固定预算覆写，直接传入 LOAD_* 环境变量）
```bash
LOAD_OBSERVERS=100000 LOAD_BIDDERS=2000 LOAD_SHARDS=4 \
LOAD_ACK_P95_MS=1000 LOAD_BROADCAST_P95_MS=1500 LOAD_SCRIPT_P99_MS=30 make load
```
  
非 P0 演练打包（建议）：
```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-rehearse
```
脚本会落库存为：
- `manifest.json`
- `summary.tsv`
- `health-start.json` / `health-end.json`
- 每次运行的 `runs/<run-id>/load.log` + `runs/<run-id>/metrics.txt`

便于后续并发证明归档。

Stretch failure is **not** a P0 gate failure (V9 §4.2 explicit).

If you perform a public remote rehearsal for a distributed run, execute the
end-to-end sequence in [docs/deploy-rehearsal-card.md](deploy-rehearsal-card.md)
to keep server-side and client-side evidence boundaries explicit.

For repeated local load-smoke checks with one summary artifact:

```sh
REPEAT_LOAD_SMOKE_ARGS="--attempts 3 --interval 5 --json --strict" \
  make load-smoke-repeat
```

For a single-shot operator flow, use:

```sh
BASE_URL="https://your-domain" \
  make deploy-perf-rehearsal \
  DEPLOY_REHEARSAL_TARGET=500 \
  DEPLOY_REHEARSAL_AID=auc_demo \
  PERF_GATE_CLIENT_SUMMARY=./client-summary.json \
  PERF_GATE_OUT_DIR=./rehearsal-perf
```

---

## 7. Reproduce

```bash
# full P0 gate
make load            # 500/50/60s + post-load verify (~90 s including build)

# repeated load smoke run + aggregate summary (recommended for trend checks)
REPEAT_LOAD_SMOKE_ARGS="--attempts 5 --interval 2 --json" \
  make load-smoke-repeat

# CI-cheap regression smoke (same code, smaller N)
make load-smoke      # 25/5/10s + post-load verify (~25 s)

# inspect live counters
curl -s http://localhost:8080/metrics | jq
```
