# Beijing-Near Locust 10k Latency Follow-Up - 2026-06-06

## Verdict

Do **not** claim a Beijing-near 10k Locust pass yet.

What is verified today:

- The public endpoint `http://115.191.76.40` is reachable.
- `/version` reports `schemaVersion=2`, so the schema-drift symptom from the previous failed run is no longer the immediate blocker.
- The endpoint still reports `buildSha="unknown"` and `buildTime="unknown"`, so the evidence pack cannot prove the exact deployed commit.
- This workstation is not a Beijing-near load worker. A strict run must execute from a `cn-beijing` or nearby cloud worker, not from the current Australia/Sydney environment.

## Public Preflight Snapshot

Captured from the current workstation on 2026-06-06:

| Check | Result |
|---|---|
| `python -m locust --version` | `locust 2.44.0` |
| `GET /healthz` | `{"status":"ok"}` |
| `GET /version` | `{"status":"ok","schemaVersion":2,"buildSha":"unknown","buildTime":"unknown","appEnv":"prod"}` |
| `GET /metrics` | reachable |

Current `/metrics` is process-lifetime, not run-window scoped. The snapshot showed `ackLatencyMs.p95=17.680865`, `ackLatencyMs.p99=95.285886`, `placeBidScriptTimeMs.p99=6.171203`, `bidHandlerOverheadMs.p99=95.612922`, `seqGapCount=0`, and `backpressureForceClose=0`. The `broadcastLatencyMs` bucket contains stale multi-hour samples, so it must be reset or treated as polluted before any public claim.

## Report Gaps

The existing public 10k report is still insufficient for a Beijing-near latency claim because it lacks:

- A Beijing-near runner identity, region, instance type, OS limits, and source IP/network path.
- A run-window metrics reset or pre/post delta for histograms.
- A current deployed commit identity (`buildSha`, `buildTime`) tied to the tested binary.
- A LIVE load auction id and token artifact manifest with secrets omitted.
- Locust worker topology: master/worker count, users per worker, spawn rate, CPU utilization, file descriptor limits, and connection-failure split.
- Host metrics during hold: gateway CPU/RAM/GC, `ss -s`, NIC throughput, Redis CPU/latency, MySQL projection lag.

## Architecture Change Under Test

The low-latency direction is to split the bidder command lane from public fanout:

- WS remains the room/session lane for `ROOM_JOIN`, snapshots, catchup, state patches, terminal events, and public observer fanout.
- `POST /api/auctions/{id}/bids` becomes the high-fanout command lane for large rooms. It still calls the same Redis Lua adjudicator and still writes the same Redis Stream/Pub/Sub events, but the originating bidder receives `BID_ACCEPTED` or `BID_REJECTED` in the HTTP response.
- This avoids single-connection head-of-line blocking where a direct bid outcome sits behind already-queued public broadcast frames on the same WS writer.
- The existing #219 WS change still matters: when clients continue to use WS `BID_PLACE`, direct/control frames are prioritized ahead of fanout frames.

This preserves the frozen design: Redis Lua remains the bid authority, Redis Stream remains the durable event log, Pub/Sub remains a live fanout hint, and AI/video remain non-authoritative.

## Beijing-Near Locust Run Shape

Run from a Beijing-near Linux worker or distributed worker pool. Do not run the 10k claim from this workstation.

Master:

```bash
export LOAD_AUCTION_ID=<live_load_auction_id>
export TOKENS_FILE=/opt/lumen-load/tokens.txt
export BID_COMMAND=http
export HTTP_HOST=http://115.191.76.40
export BIDS_PER_BIDDER=1
export ACK_TIMEOUT_SEC=5

python -m locust \
  -f tools/loadtest/locust_bidder_only.py \
  --master \
  --headless \
  --expect-workers 8 \
  --host ws://115.191.76.40 \
  -u 10000 \
  -r 500 \
  -t 180s \
  --csv beijing-locust-http-bid-10k
```

Each worker:

```bash
export LOAD_AUCTION_ID=<live_load_auction_id>
export TOKENS_FILE=/opt/lumen-load/tokens-worker-NN.txt
export BID_COMMAND=http
export HTTP_HOST=http://115.191.76.40

python -m locust \
  -f - \
  --worker \
  --master-host <master_private_ip> \
  --processes 4
```

Pass boundary:

- `connect` failure ratio < 0.1% after ramp.
- `bid_no_ack == 0` during steady hold.
- HTTP `bid_ack` p95 recorded as client-observed Beijing-near latency.
- Server `/metrics` gate: `ackLatencyMs.p95 < 80ms`, `seqGapCount == 0`, `backpressureForceClose == 0`.
- `broadcastLatencyMs`/`roomStatePatchLatencyMs` must be read from a clean run window.
- Post-run Replay Verifier reports consistent evidence for the load auction.

## Research Notes

- Locust supports distributed master/worker runs; the master does not run users, and `--expect-workers` lets a headless master wait until all workers connect before starting. Source: https://docs.locust.io/en/stable/running-distributed.html
- Locust headless mode uses `--headless`, `-u/--users`, `-r/--spawn-rate`, and `-t/--run-time`, with exit-code control available for automated gates. Source: https://docs.locust.io/en/stable/running-without-web-ui.html
- Locust can test non-HTTP protocols by wrapping a protocol client and firing request events; libraries must be gevent-compatible. Source: https://docs.locust.io/en/stable/testing-other-systems.html
- Gorilla WebSocket documents one concurrent writer per connection and `PreparedMessage`/`WritePreparedMessage`; this supports the existing single write pump and prepared fanout optimization. Source: https://pkg.go.dev/github.com/gorilla/websocket
- HAProxy WebSocket guidance requires explicit long tunnel timeouts for idle WebSocket connections. Source: https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/
- Redis Pub/Sub is at-most-once; Redis Streams provide persisted, replayable stream semantics. Sources: https://redis.io/docs/latest/develop/pubsub/ and https://redis.io/docs/latest/develop/use-cases/streaming/
- Volcengine docs list `cn-beijing` / North China 2 as a Beijing region; use this or an equivalent near-Beijing runner for the strict source-location claim. Source: https://www.volcengine.com/docs/6617/87001

## Next Required Evidence

1. Deploy a build with non-unknown `/version` identity.
2. Seed or pre-create a LIVE load auction without enabling prod dev-login.
3. Generate token shards without committing or printing tokens.
4. Run the bidder-only Locust script from Beijing-near workers with `BID_COMMAND=http`.
5. Archive Locust CSVs, clean `/metrics` pre/post snapshots, host metrics, and verifier output.
