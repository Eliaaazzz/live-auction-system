# Component 13 — Observability

> **Path**: `infra/prometheus/`, `infra/grafana/`, `apps/lumen/internal/metrics/`, `apps/ai-sidecar/internal/metrics/`
> **Owner discipline**: leader; metric naming + alert thresholds are **all-member approve** (V9 §6 + rubric 可观测性).
> **Gates trunk**: T2 (perf smoke needs panels live) → T3 (regression detection) → T8 (full dashboard for load testing) → T10 (demo-visible).
> **Cross-references**: V9 §4.3, V9 §9, [02-bid-engine](02-bid-engine.md), [04-timer-worker](04-timer-worker.md), [05-persistence-worker](05-persistence-worker.md).

## Purpose

The rubric line "可观测性（竞拍状态监控、异常告警）" is judged on **what reviewers can see** during the demo and **what alerts would fire** under stress. Per #14 challenge 10, my v1 RFC had 4 panels — V9 §4.3 actually needs ~12. This doc enumerates each metric, its purpose, the dashboard layout, and the alert rules.

Stack: **Prometheus** (scrape) + **Grafana** (visualize) + **slog** (Go structured logging) + optional **Loki** (log aggregation; defer to P1).

## Directory layout

```
infra/
├── prometheus/
│   ├── prometheus.yml          scrape config (5s interval for hot, 15s for cold)
│   ├── alerts.yml              alert rules
│   └── recording.yml           pre-aggregation rules for expensive queries
├── grafana/
│   ├── dashboards/
│   │   ├── auction-realtime.json     primary demo dashboard
│   │   ├── ai-sidecar.json           Doubao calls, cost, ban hits
│   │   ├── infra-base.json           Redis / MySQL / Go runtime
│   │   └── chaos.json                fault injection state
│   ├── datasources/
│   │   └── prometheus.yaml     auto-provisioned
│   └── provisioning/
│       └── dashboards.yaml     auto-load .json dashboards on Grafana start
└── README.md
```

```
apps/lumen/internal/metrics/
├── registry.go                 shared Prom registry; lazy-init
├── http.go                     /metrics handler (per-process; gateway / engine / api each expose)
├── collectors.go               named collectors per component
├── runtime.go                  Go GC + runtime metrics (pre-built collectors)
└── helpers.go                  Time(label) and Inc(label) helpers
```

## Metrics catalog (the 12-ish panels)

| Metric name | Type | Labels | Component | What it tells us |
|---|---|---|---|---|
| `lumen_ws_connections` | gauge | `gateway_instance` | gateway | live conn count per gateway |
| `lumen_ws_messages_total` | counter | `type, direction` | gateway | message volume |
| `lumen_ws_envelope_decode_errors_total` | counter | — | gateway | bad client envelopes |
| `lumen_ws_buffered_amount_bytes` | histogram | `channel_class` | gateway | client backpressure pressure |
| `lumen_ws_dropped_soft_total` | counter | `channel` | gateway | chat/ai drops |
| `lumen_ws_force_close_total` | counter | — | gateway | clients exceeded 4MB |
| `lumen_ws_catchup_events` | histogram | `mode` | gateway | catchup size + mode (stream/snapshot) |
| `lumen_bidengine_lua_duration_seconds` | histogram | `script` | bidengine | ⭐ critical — gate for ack p95<80ms |
| `lumen_bidengine_return_code_total` | counter | `script, code` | bidengine | distribution of OK_*/ERR_* per script |
| `lumen_bidengine_lua_errors_total` | counter | — | bidengine | Lua exceptions (should be 0) |
| `lumen_bidengine_ack_duration_seconds` | histogram | — | bidengine | ⭐ SLO: p95 < 80ms |
| `lumen_bidengine_broadcast_duration_seconds` | histogram | — | bidengine | ⭐ Engine→last viewer write; SLO p95 < 150ms |
| `lumen_timer_detection_lag_ms` | histogram | — | timer | scan time - endAtMs; SLO p95 ≤ 120ms |
| `lumen_timer_scan_duration_seconds` | histogram | — | timer | one scan tick duration |
| `lumen_timer_close_result_total` | counter | `code` | timer | OK_SOLD / OK_NO_BID / ERR_NOT_DUE / ERR_ALREADY_TERMINAL distribution |
| `lumen_persistence_consumer_lag` | gauge | `stream` | persistence | per-stream Stream→MySQL lag |
| `lumen_persistence_processed_total` | counter | `event_type` | persistence | counted by event type |
| `lumen_persistence_hash_compute_seconds` | histogram | — | persistence | HMAC cost |
| `lumen_persistence_insert_seconds` | histogram | — | persistence | MySQL insert time |
| `lumen_persistence_pel_reclaimed_total` | counter | — | persistence | how many messages we recovered from dead consumers |
| `lumen_order_create_total` | counter | `kind` | order | first vs duplicate |
| `lumen_redis_aof_fsync_duration_seconds` | histogram | — | gateway/engine (Redis INFO) | AOF stalls (V9 §4.3) |
| `lumen_go_gc_pause_seconds` | histogram | `mode` | runtime | mutator assist + stop-the-world |
| `lumen_seq_gap` | gauge | `auction_id` | bidengine | ⭐ MUST be 0; alerts on >0 |
| `ai_facts_latency_seconds` | histogram | — | ai-sidecar | VLM call time |
| `ai_auctioneer_latency_seconds` | histogram | `kind` | ai-sidecar | LLM call time |
| `ai_banwords_hits_total` | counter | — | ai-sidecar | how often the regex caught the AI |
| `ai_circuit_state` | gauge | — | ai-sidecar | 0=closed, 1=half-open, 2=open |
| `ai_tokens_total` | counter | `kind, direction` | ai-sidecar | cost accounting |
| `lumen_chaos_active` | gauge | `phase` | chaos | which fault is currently injected (for dashboard annotations) |

## Alert rules (`infra/prometheus/alerts.yml`)

```yaml
groups:
- name: lumen_critical
  rules:
  - alert: SeqGapDetected
    expr: lumen_seq_gap > 0
    for: 30s
    labels: { severity: page }
    annotations:
      summary: "Auction seq gap > 0 for {{ $labels.auction_id }}"
      runbook: "docs/runbook.md#seq-gap"

  - alert: AckLatencyHigh
    expr: histogram_quantile(0.95, rate(lumen_bidengine_ack_duration_seconds_bucket[1m])) > 0.2
    for: 1m
    labels: { severity: page }
    annotations:
      summary: "ack p95 > 200ms (above floor)"

  - alert: BroadcastLatencyHigh
    expr: histogram_quantile(0.95, rate(lumen_bidengine_broadcast_duration_seconds_bucket[1m])) > 0.5
    for: 1m
    labels: { severity: page }

  - alert: TimerDetectionLagHigh
    expr: histogram_quantile(0.95, rate(lumen_timer_detection_lag_ms_bucket[1m])) > 120
    for: 1m
    labels: { severity: page }
    annotations:
      summary: "Timer detection lag p95 > 120ms (hammer SLO at risk)"

  - alert: StreamConsumerLag
    expr: lumen_persistence_consumer_lag > 1000
    for: 1m
    labels: { severity: warn }

  - alert: BidengineLuaErrors
    expr: increase(lumen_bidengine_lua_errors_total[5m]) > 0
    labels: { severity: page }
    annotations:
      summary: "Lua execution errors detected (should be 0)"

  - alert: RedisDown
    expr: up{job="redis"} == 0
    for: 10s
    labels: { severity: page }

  - alert: MySQLDown
    expr: up{job="mysql"} == 0
    for: 30s
    labels: { severity: warn }
    annotations:
      summary: "MySQL down — auctions continue, evidence queue grows"

  - alert: AICircuitOpen
    expr: ai_circuit_state == 2
    for: 1m
    labels: { severity: warn }
    annotations:
      summary: "AI sidecar circuit breaker open — auctioneer disabled"

- name: lumen_capacity
  rules:
  - alert: AOFFsyncStall
    expr: histogram_quantile(0.99, rate(lumen_redis_aof_fsync_duration_seconds_bucket[1m])) > 0.5
    for: 1m
    labels: { severity: warn }
    annotations:
      summary: "Redis AOF fsync p99 > 500ms — bid latency may spike"

  - alert: GoGCPauseHigh
    expr: histogram_quantile(0.99, rate(lumen_go_gc_pause_seconds_bucket[1m])) > 0.05
    for: 2m
    labels: { severity: warn }
```

Alerts route to:
- `severity: page` → `docs/observed.md` (P0 we don't have real paging — log to stdout + Grafana state).
- `severity: warn` → Grafana dashboard panel turns yellow.

P1 / Stretch: actual paging via Slack webhook or email.

## Grafana dashboard layout — `auction-realtime.json`

```
Row 1: System Health (4 stat panels)
  - Active auctions count       (gauge)
  - WS connections total        (gauge)
  - Bids/sec last 1min          (gauge)
  - seq_gap (must be 0)         (stat, red if > 0)

Row 2: Latency SLOs (3 graph panels)
  - ack p50/p95/p99             (gauge with threshold lines at 80ms, 200ms)
  - broadcast p50/p95/p99       (threshold 150ms, 500ms)
  - hammer p95 vs detection-lag (multi-line)

Row 3: Throughput + Error Distribution (3 graph panels)
  - bids/sec by code (stacked: OK_ACCEPTED, OK_EXTENDED, OK_SOLD, ERR_*)
  - close results by code
  - WS messages in/out (stacked by type)

Row 4: Stream + Persistence (3 graph panels)
  - Stream consumer lag (per stream)
  - Persistence insert duration
  - Hash compute duration

Row 5: Pressure + Capacity (4 graph panels)
  - bufferedAmount distribution (heatmap)
  - dropped soft + force_close
  - Redis AOF fsync histogram
  - Go GC pause histogram

Row 6: AI (3 graph panels)
  - AI facts latency
  - AI auctioneer latency by kind
  - AI banwords hits + circuit state
```

## `apps/lumen/internal/metrics/` (Go side)

```go
// registry.go
var (
    reg = prometheus.NewRegistry()
    LuaDuration = promauto.With(reg).NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "lumen_bidengine_lua_duration_seconds",
            Help:    "Lua script execution time",
            Buckets: []float64{0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5},
        }, []string{"script"})

    AckDuration = promauto.With(reg).NewHistogram(
        prometheus.HistogramOpts{
            Name:    "lumen_bidengine_ack_duration_seconds",
            Help:    "End-to-end ack time (gateway recv → ack send)",
            Buckets: []float64{0.01, 0.025, 0.05, 0.08, 0.15, 0.3, 0.5, 1.0},
        })
    // ... etc
)

func Handler() http.Handler {
    return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}
```

Every binary mode exposes `/metrics` on its own port (8081 gateway, 8082 engine, 8083 timer, 8084 pg-writer, 8085 api).

## Structured logging (`slog`)

```go
slog.InfoContext(ctx, "bid accepted",
    "auction_id", auctionID,
    "user_id", userID,
    "seq", seq,
    "amount_cents", amount,
    "request_id", reqID,
)
```

Per V9 §6 / dev-rules §7: every log line includes `request_id` + `auction_id` / `user_id` / `seq` when applicable. JSON output to stdout; Docker compose captures to its log driver. For P1, ship to Loki.

## Recording rules (pre-aggregations)

```yaml
# infra/prometheus/recording.yml
groups:
- name: lumen_rollups
  interval: 30s
  rules:
  - record: lumen:ack_p95_5m
    expr: histogram_quantile(0.95, sum by (le) (rate(lumen_bidengine_ack_duration_seconds_bucket[5m])))
  - record: lumen:broadcast_p95_5m
    expr: histogram_quantile(0.95, sum by (le) (rate(lumen_bidengine_broadcast_duration_seconds_bucket[5m])))
  - record: lumen:bid_rate_1m
    expr: sum(rate(lumen_bidengine_return_code_total{script="place_bid"}[1m]))
```

Speeds up the dashboard significantly during load tests.

## CI verification

A dashboard linter:
```bash
# tools/dashboard-check/main.go
# Walks every panel in dashboards/*.json
# Asserts each metric referenced exists in apps/lumen + apps/ai-sidecar code (grep)
# Fails CI if dashboard references a deleted metric.
```

This prevents "demo day dashboard shows N/A for half the panels" syndrome.

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestMetrics_HandlerExposes` | `/metrics` includes all named collectors |
| `TestMetrics_LuaDurationLabeled` | observe with label → distinct buckets accumulate |
| `TestSeqGap_OnlyAdvancesWhenGap` | sequential seq → gap=0; injected gap → gauge updates |
| `TestStructuredLog_HasRequiredFields` | bid log line → grep `auction_id` `user_id` `seq` `request_id` |
| `TestDashboardJSON_AllMetricsExist` | parse dashboard json → every `expr` references a known metric |

## NEEDS HUMAN REVIEW

1. **Push vs pull**: Prometheus pull is standard. For short-lived processes (e.g. `ws-bot`), would need pushgateway. P0: pull only; ws-bot reports its own summary via stdout.
2. **Histogram bucket choice**: my `LuaDuration` buckets bottom out at 1ms. Real `place_bid.lua` should be 0.5-3ms. Tighten after T2 smoke.
3. **High-cardinality `auction_id` label on `lumen_seq_gap`**: if many concurrent auctions, this gauge explodes. Acceptable for P0 (1k auctions = 1k series). For larger, switch to global gauge with "any-gap-detected" alert + a log search to find the culprit.
4. **Grafana auth in demo**: anonymous viewer role for demo URL; admin-only for changing dashboards.
5. **Log retention**: docker compose default = forever. Add log rotation in compose config so disk doesn't fill during T8 load test.
