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
- `BASE_WS_URL` is optional when WebSocket traffic is served from a different host/domain than `BASE_URL` (for example `wss://ws.auction.example.com`).
- For production remote rehearsal, prefer HTTPS and set `DEPLOY_REHEARSAL_REQUIRE_HTTPS=1` (or `DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1` for 100k lane) so the preflight fails fast on insecure base URLs.
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
   BASE_URL="$BASE_URL" \
   BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
   AID="${AID:-auc_demo}" \
   OUT_DIR="$PREFLIGHT_OUT" \
   REQUIRE_HTTPS=1 \
   scripts/deploy-preflight.sh
   ```

   Retain `manifest.txt`, `status.tsv`, route response artifacts, and
   `metrics-summary.json`. The helper reads public endpoints:
   `/healthz`, `/metrics`, `/admin.html`, `/room.html?auction=$AID`,
   and `/ws`. By default it expects auth-gated response `401/403`; if `WS_PRECHECK_TOKEN=<token>`
   is set it also accepts a valid upgrade `101` for token-authenticated endpoints. If you want
   a strict handshake-only check, set `REQUIRE_WS_UPGRADE=true` (or `1`/`yes`/`on`) as well.

   Optional schema precheck:

   ```sh
   BASE_URL="$BASE_URL" \
     BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
     AID=auc_demo \
     REQUIRE_HTTPS=1 \
     REQUIRE_WS_SCHEMA_CHECK=true \
     WS_PRECHECK_SCHEMA="1" \
     WS_PRECHECK_TOKEN="..." \
     scripts/deploy-preflight.sh
   ```

   This opens an actual websocket handshake, sends `ROOM_JOIN`, and validates the
   first schema-bearing server message against `WS_PRECHECK_SCHEMA`. Use this for
   remote rehearsals where frontend/backend drift is a known risk.

3. Decide whether SRS is in scope.

   If the rehearsal includes live video, run the SRS smoke path from #164/#165
   and archive its evidence next to the preflight pack. If SRS fails, keep the
   bidding rehearsal separate: video is non-authoritative and must not decide bid
   order, winner, payment, or replay evidence.

4. Run the load or remote performance scenario.

   For the local 500/50 benchmark lane, run `make deploy-perf-rehearsal`.
   For Vickrey/second-price normal-tier remote rehearsal, run:
   ```sh
   BASE_URL="$BASE_URL" \
   BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
   DEPLOY_REHEARSAL_SECOND_PRICE_AID=auc_vickrey \
   make deploy-perf-rehearsal-second-price
   ```
   For the optional super-stretch remote lane, run:

   ```sh
   BASE_URL="$BASE_URL" \
   BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
   make deploy-perf-rehearsal-100k
   # 若演练房间已是二价（Vickrey）规则，可直接：
   BASE_URL="$BASE_URL" \
   BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
   DEPLOY_REHEARSAL_100K_AID=auc_vickrey \
   make deploy-perf-rehearsal-100k-second-price
   ```

   Copy-paste operator form (recommended):

   ```sh
   BASE_URL="https://auction.example.com" \
  BASE_WS_URL="https://ws.auction.example.com" \
     DEPLOY_REHEARSAL_OUT_DIR=".deploy-rehearsal-100k-$(date -u +%Y%m%dT%H%M%SZ)" \
     DEPLOY_REHEARSAL_100K_TARGET=100000 \
     DEPLOY_REHEARSAL_100K_AID=auc_demo \
     DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1 \
     DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1 \
     DEPLOY_REHEARSAL_100K_WS_SCHEMA=1 \
     DEPLOY_REHEARSAL_100K_WS_PRECHECK_TOKEN="..." \
     DEPLOY_REHEARSAL_100K_REQUIRE_HAMMER=1 \
     DEPLOY_REHEARSAL_100K_REQUIRE_CATCHUP=1 \
     DEPLOY_REHEARSAL_100K_REPORT_ONLY=0 \
     DEPLOY_REHEARSAL_METRICS="./peak-metrics.json" \
     PERF_GATE_CLIENT_SUMMARY="./client-summary.json" \
     PERF_GATE_OUT_DIR=".deploy-rehearsal-100k-$(date -u +%Y%m%dT%H%M%SZ)/perf-gate" \
     make deploy-perf-rehearsal-100k
   ```

   For 100k/2k/4-shards Vickrey checks, drive the rehearsal itself on auctions
   that are already configured with second-price rules (`rules.mode: VICKREY`, or
   legacy `auctionMode: second_price`);
   `deploy-perf-rehearsal-100k` is a remote performance/operator wrapper and does
   not inject bid mode itself.

   Result artifacts are collected in `DEPLOY_REHEARSAL_OUT_DIR` and in `PERF_GATE_OUT_DIR`.
   Keep both paths in the issue/meeting note so evidence is recoverable later.

   `*_REPORT_ONLY` controls whether remote perf gate failures should stop this
   operator target. For evidence-only runs, set to `1` and record `result:
   FAIL-REPORTED` from `remote-perf-gate.sh` as non-blocking. For strict pass/fail
   gating, keep at `0`.

   Capture the server metrics JSON at or near peak load. If a client runner such
   as k6 is used, keep its summary JSON, but do not use client RTT as the backend
   SLO source.

   If you already captured a peak-moment metrics snapshot, pass it via
   `DEPLOY_REHEARSAL_METRICS=/path/to/metrics.json`; otherwise the target will
   default to preflight `metrics/body.txt`.

5. Run the remote perf gate.

   ```sh
   SERVER_METRICS="${DEPLOY_REHEARSAL_OUT_DIR:-.deploy-rehearsal}/metrics/body.txt" \
   TARGET_CONNS="${DEPLOY_REHEARSAL_100K_TARGET:-${DEPLOY_REHEARSAL_TARGET:-500}}" \
   PERF_GATE_CLIENT_SUMMARY="${PERF_GATE_CLIENT_SUMMARY:-}" \
   PERF_GATE_OUT_DIR="${PERF_GATE_OUT_DIR:-${DEPLOY_REHEARSAL_OUT_DIR:-.deploy-rehearsal}/perf-gate}" \
   scripts/remote-perf-gate.sh \
     --server-metrics "$SERVER_METRICS" \
     ${PERF_GATE_CLIENT_SUMMARY:+--client-summary "$PERF_GATE_CLIENT_SUMMARY"} \
     --target "$TARGET_CONNS" \
     --out-dir "${PERF_GATE_OUT_DIR}"
   ```

   `SERVER_METRICS` must include the metrics required by the gate, including
   active connections, ack p95, broadcast p95, sequence-gap count, and
   backpressure force-close count. For full gate coverage it should also include
   hammer and catchup p95 metrics, or the run must explicitly document why those
   checks were not required.

   In operator runs with evidence-only mode (`DEPLOY_REHEARSAL_REPORT_ONLY=1` for
   500/50 or `DEPLOY_REHEARSAL_100K_REPORT_ONLY=1` for super-stretch),
   this command is expected to produce `result: FAIL-REPORTED` when required
   thresholds fail but still should continue with manual triage.

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
| Deploy preflight | Public routes return expected 2xx responses and artifacts are captured | Any required route is unreachable unless `ALLOW_FAILURE=1`/`true`/`yes`/`on` is intentionally documented |
| HTTPS boundary | `DEPLOY_REHEARSAL_REQUIRE_HTTPS=1` (or `DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1` for super-stretch) and `BASE_URL` starts with `https://` | `require_https` row fails when HTTPS is enforced but HTTP URL is passed |
| WebSocket reachability | `/ws` returns `401/403`, or `101` when token is allowed/provided; strict upgrade-only requires `WS_PRECHECK_TOKEN`+`REQUIRE_WS_UPGRADE=1`/`true`/`yes`/`on` | `/ws` returns unexpected HTTP status, or `101` is broken when upgrade-mode check is enabled |
| WebSocket schema guard | `ws_schema` precheck passes when `REQUIRE_WS_SCHEMA_CHECK=true`, or row is intentionally skipped when check is off | Schema mismatch, timeout, or websocket handshake error |
| Metrics capture | Backend server metrics are available at peak load | Only client-side latency or screenshots are available |
| Remote perf gate | `summary.md` reports `result: PASS` for the target tier, or `result: FAIL-REPORTED` when evidence-only mode is enabled (`DEPLOY_REHEARSAL_REPORT_ONLY=1` or `DEPLOY_REHEARSAL_100K_REPORT_ONLY=1`) | Any required server SLO row fails in strict mode (`DEPLOY_REHEARSAL_REPORT_ONLY=0` or `DEPLOY_REHEARSAL_100K_REPORT_ONLY=0`) or is missing |
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
