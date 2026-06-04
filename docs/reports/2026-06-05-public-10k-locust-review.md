# Public 10k Locust Review - 2026-06-05

## Verdict

Do **not** claim the public deployment is production-ready for single-room 10k concurrency yet.

The backend design in the current branch is directionally strong: Redis Lua remains the authoritative bid adjudicator, Redis Stream remains the replayable event log, direct bidder ACKs stay immediate, and high-fanout public state can be coalesced into room-state patches. But the deployed public endpoint at `http://115.191.76.40` is not running the current schema, and the actual public Locust 10k run failed at the connection/handshake layer before it reached a stable 10k hold.

## Scope

- Repo head under review: `754d7c3 feat(auction): recommend formal reserve from sealed prequalify`
- Public target: `http://115.191.76.40`
- ECS service: `/opt/lumen-runtime/bin/lumen serve --mode=all`
- Runtime status before/after run: `lumen.service=active`, `lumen-sidecar.service=active`
- Load auction created on ECS: `auc_load_1780585839475000540`
- Locust version: `2.44.0`

This run was driven from the current workstation to the public target. It is a public-network run against a China-hosted endpoint, but it is **not** a strict Beijing-source load test. A strict Beijing-source run needs a Beijing-region load worker or a documented network-latency injector.

## Public Endpoint Preflight

HTTP 80 was reachable:

- `/healthz` returned `{"status":"ok"}`
- `/metrics` returned JSON metrics
- `/` returned 200

Ports 443, 8080, and 3000 were not publicly reachable in the earlier probe. The current exposed production path is plain HTTP/WS on port 80, not HTTPS/WSS.

## Blocking Finding 1 - Deploy Drift

The deployed public server is stale relative to the repo head.

Evidence:

- Current repo code sends `schemaVersion=2`.
- Public server closes current clients with `4001 schema mismatch`.
- A temporary Locust client changed to `schemaVersion=1` can join and bid.

Impact:

- Public 10k results from this endpoint do not validate the current PR head.
- Current frontend clients that enforce schema 2 can fail against the public endpoint.

Issue: https://github.com/Eliaaazzz/live-auction-system/issues/209

## Blocking Finding 2 - Locust 10k Public Run Failed

Command shape:

```bash
python -m locust \
  -f <temp>/locustfile_schema1.py \
  --headless \
  --host ws://115.191.76.40 \
  -u 10000 \
  -r 500 \
  --run-time 90s \
  --only-summary \
  --csv locust-10k-schema1
```

The schema-1 client was used only because the live deployment is stale. It is not a valid current-schema proof.

Client summary:

| Metric | Value |
|---|---:|
| connect attempts | 11,477 |
| connect failures | 8,528 |
| `TimeoutError` | 4,889 |
| `WebSocketTimeoutException` | 3,279 |
| `ConnectionResetError(10054)` | 360 |
| `bid_ack` successes | 46 |
| `bid_no_ack` failures | 5,261 |
| `recv_err` failures | 451 |
| broadcast frames observed | 17,299 |

Server-side `/metrics` after the run:

```json
{
  "ackLatencyMs": {"count": 6523, "p50": 0.250966, "p95": 0.358536, "p99": 0.475841, "max": 2.118054},
  "broadcastLatencyMs": {"count": 70, "p50": 1.652368, "p95": 3.73977},
  "catchupLatencyMs": {"count": 3021, "p50": 0.626214, "p95": 0.796906, "p99": 0.961936},
  "placeBidScriptTimeMs": {"count": 127, "p50": 0.380341, "p95": 0.486482},
  "bidsAccepted": 69,
  "bidsRejected": 6397,
  "bidsRejectedFastPath": 6396,
  "backpressureForceClose": 0,
  "seqGapCount": 0,
  "activeConns": 0
}
```

Mid-run server snapshot showed `activeConns` around `3454`, not 10,000. The bid engine stayed fast for the subset that connected, but the public single-entry deployment did not survive a 10k connection ramp.

Issue: https://github.com/Eliaaazzz/live-auction-system/issues/210

## Blocking Finding 3 - Timer Corruption Noise

During the run window, ECS logs repeatedly emitted:

```text
ERROR timer close auc_load_...: ERR_INTERNAL (state/stream corruption);
untracking to stop the 100ms retry loop, reconcile will re-probe in 5s
```

This appears tied to old `auc_load_*` artifacts, but it is still production log noise and should not run indefinitely.

Issue: https://github.com/Eliaaazzz/live-auction-system/issues/211

## Architecture Review

Current branch strengths:

- Redis Lua remains the authority for accepted bids and seq assignment.
- Redis Stream provides replay/catchup/evidence; Pub/Sub is only a live wakeup/fanout aid.
- Direct bidder ACK remains separate from public observer fanout.
- Large rooms can coalesce public bid events into `ROOM_STATE_PATCH` without coalescing terminal events.
- `bidsRejectedFastPath` exists, and the public run shows it is active: 6,396 of 6,397 rejects were fast-path rejects.

Current production-readiness gaps:

- Public deploy has no build/schema version endpoint, so deploy drift was only found by a protocol failure.
- Single ECS `--mode=all` behind naked port 80 is not enough evidence for public 10k.
- Locust is a behavioral harness, not the strongest 10k socket generator; the repo's own docs correctly say Go `wsload` is the real 10k harness. Locust still exposed useful handshake failure data.
- Token prewarming through `/api/login` is slow: 1000 tokens took 176.5 seconds at 8 concurrent workers. This is acceptable for real users, but not for creating a 10k test population on demand.
- Metrics histograms are process-lifetime and can be polluted by old outliers; production load reports need a run-window reset or pre/post delta convention for histograms.

## Industry Research Notes

- Redis Pub/Sub is at-most-once; if a subscriber is disconnected or cannot handle a message, that message is lost. This supports the current design choice that Pub/Sub must not be the durable authority. Source: Redis Pub/Sub docs, https://redis.io/docs/latest/develop/pubsub/
- Redis Streams are an append-only log and support replay/consumer-group patterns. This supports keeping Stream as the source of truth for catchup and evidence. Sources: Redis Streams docs, https://redis.io/docs/latest/develop/data-types/streams/ and Redis streaming docs, https://redis.io/docs/latest/develop/use-cases/streaming/
- Classic browser WebSocket does not give the same automatic backpressure model as stream-based APIs; MDN positions `WebSocketStream`/WebTransport as backpressure-aware alternatives. This supports explicit gateway slow-consumer control and patch coalescing. Sources: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API and https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Using_WebSocketStream
- Gorilla WebSocket provides `PreparedMessage` to efficiently send the same payload to multiple connections. This is a good fit for hot fanout broadcasts. Source: https://pkg.go.dev/github.com/gorilla/websocket
- HAProxy's WebSocket guidance emphasizes long-lived tunnel timeouts; production WebSocket load balancing needs explicit tunnel handling, not default short HTTP timeouts. Source: https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/

## Innovation Issues Opened

1. Adaptive large-room fanout controller: https://github.com/Eliaaazzz/live-auction-system/issues/212
   - Dynamic switch between full fanout and `ROOM_STATE_PATCH`
   - Metrics-driven room pressure model
   - Slow-consumer risk and coalescing ratio surfaced in dashboard

2. Confidence-scored reserve advisor from sealed prequalify demand: https://github.com/Eliaaazzz/live-auction-system/issues/213
   - Reserve range and confidence, not a single opaque number
   - Seller-facing strategy simulation
   - Explainable recommendation tied to sealed reveal aggregate

## Recommended Fix Order

1. Fix deploy drift first: atomic deploy, `/version`, post-deploy current-schema WS smoke.
2. Re-run current-schema 100-user smoke; require zero schema mismatch and no `bid_no_ack`.
3. Clean or quarantine stale `auc_load_*` corruption loops.
4. Re-run 10k with a realistic ramp and a Beijing-region load worker.
5. Add L4/L7 WebSocket-ready fronting and/or multi-gateway mode before claiming public 10k.
6. Keep Go `wsload` as the hard socket-count harness; use Locust for behavioral mixes and public regression evidence.

## Final Claim Boundary

Current honest claim:

> The current architecture has the right core design for 10k fanout, and local/server-side components remain fast under the subset of public load that connected. The public deployment is not yet production-ready for verified 10k single-room concurrency.

Do not claim:

> Public 10k single-room production readiness.

until #209 and #210 are resolved with current-schema artifacts and a successful public run.
