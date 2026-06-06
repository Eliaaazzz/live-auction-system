# Beijing-Near Locust 10k Latency Follow-Up - 2026-06-06

## Verdict

Do **not** claim a public-path Beijing-near 10k Locust pass yet.

Updated on 2026-06-06 after deploying `291ecf31dba1` through CD:

- **CD is now verified**: PR #227 was approved, merged, and deployed by `deploy-prod` run `27064090243`; public `/version` reports `buildSha="291ecf31dba1"` and `schemaVersion=2`.
- **Locust 10k public path failed** on the Beijing ECS co-located runner: 10,000 WS connect attempts produced 9,360 failures. This is not a 10k pass.
- **Go `wsload` 10k public path also failed** when the Beijing ECS dialed its own public IP `115.191.76.40:80`: `connect_ok=3378`, `connect_fail=6622`, `peak_concurrent=2958`, server-selected `activeConns=1173`.
- **Go `wsload` 10k loopback isolation passed** against the same production `lumen` process on `127.0.0.1:80`: `connect_ok=10000`, `connect_fail=0`, `peak_concurrent=10000`, `closed_early=0`, server-selected `activeConns=10000`, `ackLatencyMs.p95=0.511673ms`, `seqGapCount=0`, `backpressureForceClose=0`, and Replay Verifier reported `consistent`.
- **Go `wsload` 10k private-IP isolation also passed** against `172.31.12.98:80`: `connect_ok=10000`, `connect_fail=0`, server-selected `activeConns=10000`, `ackLatencyMs.p95=0.509134ms`, `seqGapCount=0`, `backpressureForceClose=0`, and Replay Verifier reported `consistent`.

Honest claim boundary:

- The deployed app/gateway process can hold 10,000 live WS sessions with very low server-side latency on the Beijing ECS loopback path.
- The same production process can also hold 10,000 live WS sessions on the ECS private address; this is the expected path for independent Beijing workers in the same VPC.
- The public-path 10k claim is still blocked by load topology: self-dialing the ECS public IP causes TCP/WebSocket `i/o timeout` failures and does not represent clean external Beijing-near worker traffic.
- Final public evidence still needs separate Beijing-near Linux load workers, or a private/LB endpoint that avoids single-host public-IP hairpin.

What is verified today:

- The public endpoint `http://115.191.76.40` is reachable.
- `/version` reports `schemaVersion=2` and a non-unknown deployed build identity.
- The load runner for the new evidence was the Volcengine Beijing ECS itself (`RUNNER_REGION=cn-beijing`), not the Australia/Sydney workstation.
- Token values were not copied into evidence; only token count and token file sha256 were recorded.

## Current Deployment Snapshot

Captured after CD run `27064090243` on 2026-06-06:

| Check | Result |
|---|---|
| `GET /healthz` | `{"status":"ok"}` |
| `GET /version` | `{"status":"ok","schemaVersion":2,"buildSha":"291ecf31dba1","buildTime":"2026-06-06T13:52:07Z","appEnv":"prod"}` |
| ECS listen path | `lumen serve --mode=all` listening on `*:80`; `sidecar` listening on `*:8090` |
| ECS size | 4 vCPU / 8 GiB class host from host snapshot |

Metrics are reset with `POST /admin/metrics/reset` before each strict evidence run. The reset token is configured on ECS but is intentionally not printed or copied into artifacts.

## 2026-06-06 Runs

### A. Locust 10k Public Path - FAIL

Evidence directory: `/opt/lumen-load/evidence-locust-10k-20260606T134644Z`

| Metric | Value |
|---|---:|
| WS connect attempts | 10,000 |
| WS connect failures | 9,360 |
| Locust `room_join` | 640 |
| Locust aggregate failures | 10,298 / 37,611 |
| selected server `activeConns` | 393 |
| server `ackLatencyMs.p95` | 1.49653 ms |
| server `roomStatePatchLatencyMs.p95` | 48.650216 ms |
| `seqGapCount` | 0 |
| `backpressureForceClose` | 0 |

Primary failure mode: `websocket.create_connection` timed out during handshake and HTTP bid commands timed out at 5 seconds. This invalidates any 10k Locust pass claim.

### B. Go `wsload` 10k Public IP Hairpin - FAIL

Evidence directory: `/opt/lumen-load/evidence-wsload-10k-20260606T142007Z`

| Metric | Value |
|---|---:|
| target connections | 10,000 |
| connect OK | 3,378 |
| connect FAIL | 6,622 |
| peak concurrent client sockets | 2,958 |
| closed early | 2,917 |
| server-selected `activeConns` | 1,173 |
| server `ackLatencyMs.p95` | 0.334363 ms |
| server `seqGapCount` | 0 |
| server `backpressureForceClose` | 0 |
| Replay Verifier | `consistent: stream=8 mysql=8 snapshot_seq=8` |

Primary failure mode: the runner was on the ECS and dialed the ECS public IP (`172.31.12.98 -> 115.191.76.40:80`), producing widespread TCP/WebSocket `i/o timeout`. This is a topology defect in the evidence run, not a Redis Lua latency breach.

### C. Go `wsload` 10k Loopback Isolation - PASS

Evidence directory: `/opt/lumen-load/evidence-wsload-loopback80-10k-20260606T143148Z`

| Metric | Value |
|---|---:|
| target connections | 10,000 |
| connect OK | 10,000 |
| connect FAIL | 0 |
| peak concurrent client sockets | 10,000 |
| closed early | 0 |
| frames received | 9,455,716 |
| bids sent / accepted / rejected | 119,646 / 1,199 / 118,447 |
| client bid-ack RTT p95 | 0.6 ms |
| server-selected `activeConns` | 10,000 |
| server `ackLatencyMs.p95` | 0.511673 ms |
| server `ackLatencyMs.p99` | 5.275259 ms |
| server `roomStatePatchLatencyMs.p95` | 44.109133 ms |
| server `catchupLatencyMs.p95` | 1.832162 ms |
| server `seqGapCount` | 0 |
| server `backpressureForceClose` | 0 |
| Replay Verifier | `consistent: stream=1199 mysql=1199 snapshot_seq=1199` |

This isolates the application/gateway hot path: the production process can hold 10k same-host WS sessions with low server-side latency. It is not a substitute for independent Beijing-near public/LB traffic.

### D. Go `wsload` 10k Private-IP Isolation - PASS

Evidence directory: `/opt/lumen-load/evidence-wsload-privateip-10k-20260606T144923Z`

| Metric | Value |
|---|---:|
| target connections | 10,000 |
| connect OK | 10,000 |
| connect FAIL | 0 |
| peak concurrent client sockets | 10,000 |
| closed early | 0 |
| frames received | 9,458,600 |
| bids sent / accepted / rejected | 119,646 / 1,199 / 118,447 |
| client bid-ack RTT p95 | 0.7 ms |
| server-selected `activeConns` | 10,000 |
| server `ackLatencyMs.p95` | 0.509134 ms |
| server `ackLatencyMs.p99` | 5.981908 ms |
| server `roomStatePatchLatencyMs.p95` | 72.974526 ms |
| server `catchupLatencyMs.p95` | 1.80242 ms |
| server `seqGapCount` | 0 |
| server `backpressureForceClose` | 0 |
| Replay Verifier | `consistent: stream=1199 mysql=1199 snapshot_seq=1199` |

This proves the private-address path is not the bottleneck. A second ECS in the same VPC should target the gateway's private IP or a private load balancer instead of the gateway host dialing its own public IP.

## Report Gaps

The public-path 10k report is still insufficient for a final Beijing-near latency claim because it lacks:

- Independent Beijing-near Linux load workers. The ECS self-run is Beijing-located but co-located with the gateway.
- A public or private load-balanced endpoint that avoids self-dialing the ECS public IP from the same host. The private-address isolation run passed, so same-VPC workers should use the gateway private IP or a private LB.
- Token shards across workers. Current evidence uses one 10k token file on one runner and records only count/sha256.
- Clean public-path worker host metrics during hold: gateway CPU/RAM/GC, `ss -s`, NIC throughput, Redis CPU/latency, and MySQL projection lag.
- A public-path Replay Verifier run with enough accepted bids to prove the same stream depth as the loopback pass.

The following former gaps are now closed for the loopback isolation evidence: deployed build identity, clean metrics reset, LIVE load auction id, no-secret token manifest, host snapshots, server gate, wsload gate, and Replay Verifier output.

The repository now includes the final independent-worker wrapper:
`scripts/beijing-wsload-remote-10k-evidence.sh`. It takes a worker host list,
splits tokens into shards, launches each worker with `tools/loadtest/wsload/run-remote-workers.sh`,
captures a clean server metrics window, runs both server/wsload gates, and stores
Replay Verifier output in one no-secret evidence directory.

## Architecture Change Under Test

The low-latency direction is to split the bidder command lane from public fanout:

- WS remains the room/session lane for `ROOM_JOIN`, snapshots, catchup, state patches, terminal events, and public observer fanout.
- `POST /api/auctions/{id}/bids` becomes the high-fanout command lane for large rooms. It still calls the same Redis Lua adjudicator and still writes the same Redis Stream/Pub/Sub events, but the originating bidder receives `BID_ACCEPTED` or `BID_REJECTED` in the HTTP response.
- This avoids single-connection head-of-line blocking where a direct bid outcome sits behind already-queued public broadcast frames on the same WS writer.
- The existing #219 WS change still matters: when clients continue to use WS `BID_PLACE`, direct/control frames are prioritized ahead of fanout frames.

This preserves the frozen design: Redis Lua remains the bid authority, Redis Stream remains the durable event log, Pub/Sub remains a live fanout hint, and AI/video remain non-authoritative.

The evidence harness also changed after the Locust failure:

- Keep Locust for behavioral mixed-load and HTTP command-lane latency characterization.
- Use Go `wsload` for the 10k connection/fanout proof, because the repository's `tools/loadtest/README.md` already documents `wsload` as the intended 10k harness and Locust as lower-ceiling behavioral load.
- Gate on server `/metrics` plus `wsload` connect counts and Replay Verifier. Client RTT is retained as observed evidence, not as the backend SLO boundary.

## Beijing-Near Locust Run Shape

Run from a Beijing-near Linux worker or distributed worker pool. Do not run the 10k claim from this workstation. The strict path is now scripted; manual commands below are for understanding, not for final evidence.

First split token shards without printing token values:

```bash
WORKERS=8 USERS=10000 TOKENS=/opt/lumen-load/tokens.txt \
  AID=<live_load_auction_id> \
  BASE_URL=http://115.191.76.40 \
  WS_HOST=ws://115.191.76.40 \
  tools/loadtest/split-locust-tokens.sh
```

Strict evidence-pack run on the Beijing-near master:

```bash
RUNNER_REGION=cn-beijing \
LOAD_AUCTION_ID=<live_load_auction_id> \
TOKENS_FILE=/opt/lumen-load/tokens.txt \
BASE_URL=http://115.191.76.40 \
WS_HOST=ws://115.191.76.40 \
EXPECT_WORKERS=8 \
USERS=10000 \
SPAWN_RATE=500 \
RUN_TIME=180s \
METRICS_RESET_TOKEN=<operator-token> \
VERIFY_CMD='ssh <ecs> "cd live-auction-system && VERIFY_AID=$LOAD_AUCTION_ID make verify"' \
scripts/beijing-locust-10k-evidence.sh master
```

Each Beijing-near worker runs the command from `workers.tsv`, equivalent to:

```bash
RUNNER_REGION=cn-beijing \
LOAD_AUCTION_ID=<live_load_auction_id> \
TOKENS_FILE=/opt/lumen-load/tokens-worker-NN.txt \
BASE_URL=http://115.191.76.40 \
WS_HOST=ws://115.191.76.40 \
BID_COMMAND=http \
scripts/beijing-locust-10k-evidence.sh worker --master-host <master_private_ip>
```

Pass boundary:

- `connect` failure ratio < 0.1% after ramp.
- `bid_no_ack == 0` during steady hold.
- HTTP `bid_ack` p95 recorded as client-observed Beijing-near latency.
- Server `/metrics` gate: `ackLatencyMs.p95 < 80ms`, `seqGapCount == 0`, `backpressureForceClose == 0`.
- `broadcastLatencyMs`/`roomStatePatchLatencyMs` must be read from a clean run window.
- Post-run Replay Verifier reports consistent evidence for the load auction.

The strict script writes a no-secret evidence directory containing:

- `version.json`, `healthz.json`, metrics reset response, clean pre-run metrics, post-run metrics.
- `server-metrics-window/metrics.json` selected from the highest active connection sample.
- Locust CSV/HTML plus `locust-gate/locust-gate.tsv`.
- `server-gate/gate.tsv` from `scripts/remote-perf-gate.sh`.
- `host-before/` and `host-after/` snapshots from the master and each worker.
- `replay-verifier.log`.

The run fails by default if:

- `RUNNER_REGION` is not Beijing-near.
- `/version` has `buildSha` or `buildTime` equal to `unknown`.
- Metrics cannot be reset through `POST /admin/metrics/reset`.
- `connect` failure ratio is above 0.1%.
- Any `bid_no_ack` appears.
- Server-side SLO gate fails.
- Replay Verifier output is missing or non-zero.

## Research Notes

- Locust supports distributed master/worker runs; the master does not run users, and `--expect-workers` lets a headless master wait until all workers connect before starting. Source: https://docs.locust.io/en/stable/running-distributed.html
- Locust headless mode uses `--headless`, `-u/--users`, `-r/--spawn-rate`, and `-t/--run-time`, with exit-code control available for automated gates. Source: https://docs.locust.io/en/stable/running-without-web-ui.html
- Locust can test non-HTTP protocols by wrapping a protocol client and firing request events; libraries must be gevent-compatible. Source: https://docs.locust.io/en/stable/testing-other-systems.html
- Gorilla WebSocket documents one concurrent writer per connection and `PreparedMessage`/`WritePreparedMessage`; this supports the existing single write pump and prepared fanout optimization. Source: https://pkg.go.dev/github.com/gorilla/websocket
- HAProxy WebSocket guidance requires explicit long tunnel timeouts for idle WebSocket connections. Source: https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/
- Redis Pub/Sub is at-most-once; Redis Streams provide persisted, replayable stream semantics. Sources: https://redis.io/docs/latest/develop/pubsub/ and https://redis.io/docs/latest/develop/use-cases/streaming/
- Volcengine docs list `cn-beijing` / North China 2 as a Beijing region; use this or an equivalent near-Beijing runner for the strict source-location claim. Source: https://www.volcengine.com/docs/6617/87001

## Remaining External Prerequisites

The repository now contains the command-lane code, metrics reset hook, token sharder, Locust gate, Go `wsload`, and strict evidence-pack scripts. The remaining work is external public-path execution:

1. Provision one or more Beijing-near Linux load workers that are not the gateway host.
2. Generate buyer tokens through the allowed public login flow, then split them into disjoint worker shards.
3. Run `scripts/beijing-wsload-remote-10k-evidence.sh` against the private gateway IP or private LB from those workers; use Locust separately for command-lane behavior sweeps.
4. Keep `/metrics` reset and Replay Verifier mandatory for every final evidence pack.
5. Attach the no-secret evidence directories to #210 and name any failed gate instead of claiming a pass.
