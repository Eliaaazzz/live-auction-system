# 2026-06-07 Tier-2 public load-test report: 10k passes / 20k single-gateway capacity boundary

> Source of truth: issue #233.  
> Purpose: materialize the report file referenced by `docs/demo/tech-differentiation.md`, `docs/final-submission/final-demo-deck.md`, and final demo/submission material. This file intentionally mirrors the public evidence summary from #233 so those references are no longer dead links.

---

## Summary

This round drove traffic from an out-of-region pay-as-you-go worker (cn-shanghai) across the public internet to the Beijing gateway's EIP, avoiding the NAT hairpin / self-dial problem that a Beijing ECS hit when dialling its own public IP. The target gateway is a single `c4i.xlarge` (4 vCPU / 8 GiB) running a bare binary: `lumen serve --mode=all`, build `291ecf31`, prod environment.

The conclusion has two layers:

1. **10,000 concurrent connections with a real bidding path passes.** In the 10k baseline scenario every §4.2 SLO is green, the auction settles correctly, `seqGapCount=0`, and `backpressureForceClose=0`. This is the project's first real "public-internet 10k-scale auction" evidence.
2. **20,000 connections / roughly 50k bids/s exposes the single-gateway capacity boundary.** With active bidders raised to 10,000 and total connections at 20,000, a single gateway crashes and auto-restarts at roughly 15,777 connections. Correctness was not broken before or after the crash, but gateway CPU / memory became the bottleneck, which calls for admission control, per-connection memory reduction, GC forensics, and eventually multi-gateway fanout.

---

## Environment

| Item | Value |
|---|---|
| Test date | 2026-06-07 |
| Load worker | Out-of-region pay-as-you-go worker, cn-shanghai |
| Gateway | Beijing gateway public EIP, `ws://115.191.76.40:80` |
| Server shape | A single `c4i.xlarge`, 4 vCPU / 8 GiB |
| Server process | Bare binary `lumen serve --mode=all` |
| Build | `291ecf31` |
| Transport | Plaintext `ws://`, no domain certificate; `wss://` still to be done |
| WAN RTT | ~22 ms |

---

## SLO / budget

| Metric | Budget |
|---|---:|
| server ack p95 | < 80 ms |
| room state patch p95 | < 150 ms |
| catchup p95 | < 1 s |
| seqGapCount | 0 |
| backpressureForceClose | 0 |

---

## Three-scenario results

| Scenario | Connection mix | Bid pressure | Peak concurrency | Result | ack p95 | patch p95 | seqGap | bpClose |
|---|---|---:|---:|---|---:|---:|---:|---:|
| A. 10k baseline | 9,900 viewers + 100 bidders | ~500 bids/s | 10,000 | ✅ Clean, auction SOLD | 0.46 ms | 73 ms | 0 | 0 |
| C. 10k 4:6 | 6,000 viewers + 4,000 bidders | ~20,000 bids/s | 10,000 (steady state ~9,874) | ✅ SLO/correctness met, a few early exits | 3.5 ms | 58 ms | 0 | 0 |
| B. 20k storm | 10,000 viewers + 10,000 bidders | ~50,000 bids/s | 15,777 | ❌ Process crash + auto-restart | ~110 ms peak | 73 ms | 0 | 0 |

---

## Scenario A: 10k baseline

Client summary:

```text
connect OK 10000 / FAIL 0 / peak 10000 / closed early 0
frames 26,775,893
bids 359,625 sent / 2,938 acc / 356,678 rej
```

The auction expired naturally and was SOLD: winner `user_load_3`, price `100000 -> 103162`, `seq=3163`, no holes, a single winner.

Verdict: 10k public-internet connections with a real bidding path pass cleanly.

---

## Scenario C: 10k high-activity 4:6

Client summary:

```text
connect OK 10000 / FAIL 0 / peak 10000 / closed early 126 (~1.3%)
frames 25,760,340
bids 7,913,906 sent / 2,096 acc / 7,910,638 ERR_TOO_LOW
bidsRejectedFastPath 7,911,796
```

Interpretation: roughly 99.97% of the doomed low bids are absorbed by the gateway fast-reject, which is why ack p95 stays at a stable 3.5 ms under roughly 40× the bid pressure.

Verdict: in a high-activity 10k scenario the fast-reject and room state patch designs work, and server-side SLO and correctness hold. This scenario still recorded 126 early-exit connections (~1.3%), so the final materials should call it "high-activity 10k meets SLO/correctness" and must not claim "zero early exits across all connections".

---

## Scenario B: 20k storm

Client summary:

```text
connect OK 19999 / FAIL 1 / peak 15,777 / closed early 19999
bids 5,043,257 sent / 753 acc / 4,234,994 ERR_TOO_LOW
```

Sequence of events: `activeConns` climbed to roughly 15,777 and capped there, with ack p95 rising to about 110 ms. After holding for about 98 seconds the `lumen` process crashed and auto-restarted, dropping every connection. After the restart `/metrics` reset to zero with `activeConns=0`.

Correctness: before the crash `seqGapCount=0` and `backpressureForceClose=0`; after the restart the auction was still LIVE and `seq=753` was contiguous in Redis.

Verdict: the 20k storm exposes the single-gateway capacity boundary; this is a stability / capacity problem, not an adjudication-correctness problem.

---

## Root-cause assessment

The most likely bottleneck is single-gateway CPU / memory / GC pressure rather than bandwidth or the load generator:

- `backpressureForceClose=0`, so slow-client force-close never fired.
- `roomStatePatch.p95` was still around 73 ms and the 200 Mbps EIP was not saturated.
- Worker load average was about 0.65 with roughly 14k established TCP connections, so the load generator was not the bottleneck.
- `/metrics` reset to zero after the crash, which shows we need better crash forensics: pprof, gctrace, heap / goroutine gauges, and distinguishing OOM from panic.

---

## Engineering work this produced

This report directly drove the gateway load-shedding work in #235:

- WebSocket admission gate: past `MAX_WS_CONNS` new connections get a 503 + `Retry-After`, which stops the process climbing to the OOM cliff.
- CAS reservation: the admission counter uses an atomic compare-and-swap so a reconnect burst cannot slip past the cap through check-then-add.
- Per-connection memory reduction: lower the cost of the per-connection critical / broadcast lane buffers.
- Runtime observability: added admission-rejected, heap, and goroutine metrics plus pprof / gctrace forensics.
- Multi-gateway fanout next: turn the single-gateway capacity boundary into a horizontal scale-out path.

---

## Suggested wording for submission materials

Recommended phrasing for the final submission:

> We completed a real public-internet load test at 10,000 concurrent connections. In the 10k baseline scenario the auction was correctly SOLD, ack p95 and room patch p95 both met budget, and `seqGap=0`, showing that the real-time adjudication and broadcast paths stay correct at 10k scale. A further high-activity 10k scenario maintained server-side SLO and correctness under roughly 20k bids/s, but recorded about 1.3% early-exit connections, so it should be presented as high-activity boundary evidence rather than "zero early exits". The 20k storm test then exposed the single-gateway capacity boundary: at roughly 15.8k connections and 50k bids/s a single gateway crashed and restarted under memory / GC pressure, while the auction state and `seq` continuity in Redis stayed intact. On that basis we added admission control, per-connection memory reduction, and forensic metrics, turning the crash cliff into an engineering path toward graceful degradation.

---

## Follow-ups

- [ ] Add a `wss://` public verification round once a domain certificate is in place.
- [ ] Re-run the 14k / 20k overload on the gateway after #235 merges, to verify `activeConns` plateaus at the watermark, `admissionRejected` grows, and `/healthz` / `/metrics` do not reset to zero.
- [ ] Keep three pieces of forensics: `/metrics` snapshots at test start / peak / end, gateway logs, and pprof heap + goroutine profiles.
- [ ] Keep pushing the multi-gateway fanout / room affinity path so a single machine does not become a long-term ceiling.

---

## References

- Issue #233: the raw conclusions and data from the public Tier-2 10k / 20k load test.
- PR #235: the admission control, memory reduction, and GC / pprof forensics driven by this report.
- Issue #231: the NAT hairpin problem when Beijing dialled its own public IP, and the Tier-1 topology boundary.
