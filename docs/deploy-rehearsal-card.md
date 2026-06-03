# Deploy rehearsal operator card

This card turns the deploy, media, and remote performance helpers into one
operator path for a remote auction rehearsal. It is intended to reduce PR-comment
hunting during the #112/#121 rehearsal work and keep the evidence boundary clear.

## Scope

Use this when rehearsing a public or remote Lumen Auction stack before claiming a
larger concurrency tier.

- #148 deploy preflight establishes that public routes are reachable and records
  a no-secret evidence pack.
- #164/#165 SRS checks are optional and only apply when the live video path is in
  scope for the rehearsal.
- #176 remote perf gate evaluates backend-owned server SLOs from captured server
  metrics and archives client latency as observed evidence only.
- #154 teardown is the final cleanup and cost-control step after the rehearsal.

> [!warning]
> This card does not make a 100,000-concurrent-user claim by itself. Treat the
> P0 demonstrated tier as the proven 500/50 scenario unless a distributed
> v100k evidence bundle and verifier pass are attached. Client RTT, WAN latency,
> video delivery, proxy delay, and runner delay are not backend SLO proof.

## Preconditions

- `BASE_URL` points at the remote stack root, for example `https://auction.example.com`.
- No secrets, cookies, cloud tokens, or provider credentials are written into the
  repository or evidence bundle.
- Backend `/metrics` output can provide the required server-side latency fields
  for the remote perf gate.
- Local fallback remains available, but local-only results must not be presented
  as remote concurrency proof.

## Operator sequence

1. Bring up the remote stack.

   Record the deployment target, build identifier, backend commit, and expected
   target concurrency. Keep provider console screenshots or IDs outside the repo
   if they expose private account details.

2. Run deploy preflight.

   ```sh
   BASE_URL="$BASE_URL" AID="${AID:-auc_demo}" OUT_DIR="$PREFLIGHT_OUT" scripts/deploy-preflight.sh
   ```

   Retain `manifest.txt`, `status.tsv`, route response artifacts, and
   `metrics-summary.json`. The helper reads only public HTTP endpoints:
   `/healthz`, `/metrics`, `/admin.html`, and `/room.html?auction=$AID`.

3. Decide whether SRS is in scope.

   If the rehearsal includes live video, run the SRS smoke path from #164/#165
   and archive its evidence next to the preflight pack. If SRS fails, keep the
   bidding rehearsal separate: video is non-authoritative and must not decide bid
   order, winner, payment, or replay evidence.

4. Run the load or remote performance scenario.

   Capture the server metrics JSON at or near peak load. If a client runner such
   as k6 is used, keep its summary JSON, but do not use client RTT as the backend
   SLO source.

5. Run the remote perf gate.

   ```sh
   scripts/remote-perf-gate.sh \
     --server-metrics "$SERVER_METRICS" \
     --client-summary "$CLIENT_SUMMARY" \
     --target "$TARGET_CONNS" \
     --out-dir "$PERF_GATE_OUT"
   ```

   `SERVER_METRICS` must include the metrics required by the gate, including
   active connections, ack p95, broadcast p95, sequence-gap count, and
   backpressure force-close count. For full gate coverage it should also include
   hammer and catchup p95 metrics, or the run must explicitly document why those
   checks were not required.

6. Archive the evidence pack.

   Keep these artifacts together:

   - preflight `manifest.txt`
   - preflight `status.tsv`
   - preflight route artifacts
   - server metrics JSON used by the perf gate
   - remote perf gate `summary.md`
   - remote perf gate `gate.tsv`
   - optional `client-summary.json`
   - optional `client-observed.tsv`
   - optional SRS smoke evidence

7. Run teardown.

   Follow the #154 teardown/cost checklist after the evidence has been copied to
   its durable location. Record which remote resources were stopped or deleted.

## Go/no-go table

| Gate | Go condition | No-go condition |
| --- | --- | --- |
| Deploy preflight | Public routes return expected 2xx responses and artifacts are captured | Any required route is unreachable unless `ALLOW_FAILURE=1` is intentionally documented |
| Metrics capture | Backend server metrics are available at peak load | Only client-side latency or screenshots are available |
| Remote perf gate | `summary.md` reports `result: PASS` for the target tier | Any required server SLO row fails or is missing |
| SRS smoke | Required only when live video is part of the rehearsal | SRS failure blocks video demo only, not bid correctness |
| Teardown | Resources are stopped or deleted and cost risk is closed | Orphaned remote resources remain |

## Claim wording

Use conservative wording in release notes, PR comments, and demos:

- Good: "Remote gate passed for target N with server ack p95 X ms and broadcast
  p95 Y ms; client RTT retained as observed evidence."
- Good: "SRS smoke failed, so video demo is out of scope for this run; bidding
  and replay evidence remain authoritative."
- Bad: "The system supports 100,000 users" without a v100k distributed evidence
  bundle and verifier pass.
- Bad: "Client p95 proves backend p95" because WAN, browser, proxy, and runner
  delays are outside the backend SLO boundary.
