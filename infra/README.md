# `infra/` — Local + demo infrastructure

This directory holds **infrastructure config files** that the docker-compose stack (lives in T0b PR) wires in. The Go binaries and web apps live in `apps/`; configs that they consume at runtime live here.

Currently shipped:
- `prometheus/` — scrape config, alert rules, recording rules
- `grafana/` — dashboards (JSON) + datasource + provisioning
- *(future)* `toxiproxy/`, `redis/`, `mysql/`, `nginx/` — land in their respective scope PRs

## Wiring into `docker-compose.yml`

When Eliaaazzz's T1 PR creates `infra/docker-compose.yml`, the observability bits drop in as:

```yaml
services:
  prometheus:
    image: prom/prometheus:v2.54.1
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro
      - ./prometheus/recording.yml:/etc/prometheus/recording.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=7d'
      - '--web.enable-lifecycle'
    ports:
      - "9090:9090"
    depends_on:
      - lumen-bid-engine
      - lumen-gateway
      - ai-sidecar

  grafana:
    image: grafana/grafana:11.2.0
    volumes:
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
      - ./grafana/datasources:/etc/grafana/provisioning/datasources:ro
      - ./grafana/provisioning:/etc/grafana/provisioning/dashboards:ro
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=lumen
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_DASHBOARDS_MIN_REFRESH_INTERVAL=5s
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  redis-exporter:
    image: oliver006/redis_exporter:v1.62.0
    environment:
      - REDIS_ADDR=redis://redis:6379
    ports:
      - "9121:9121"

  mysqld-exporter:
    image: prom/mysqld-exporter:v0.15.1
    environment:
      - DATA_SOURCE_NAME=lumen:lumen@(mysql:3306)/lumen
    ports:
      - "9104:9104"

volumes:
  prometheus-data:
  grafana-data:
```

After `make up`, dashboards are at http://localhost:3000 (anon Viewer enabled for demo).

## Per-binary `/metrics` endpoint convention

**T1 (per PR #19): single lumen process, `--mode=all`, port 8080.** Prometheus scrapes a single `lumen:8080` target. The per-mode ports below are the T5+ split-topology target inventory (commented out in `prometheus.yml` until compose splits modes into separate services — keeps T1 from showing red GatewayDown alerts on phantom scrape targets):

| Mode (T5+ split-process) | Port |
|---|---|
| api | 8085 |
| gateway | 8081 |
| bid-engine | 8082 |
| timer | 8083 |
| persistence (subcommand `--mode=pg-writer`) | 8084 |
| ai-sidecar (separate process) | 9090 |

The subcommand keeps its `--mode=pg-writer` name (matches PR #19 `apps/lumen/cmd/lumen/main.go`). User-facing language is **Persistence Worker** / **MySQL projection**.

## Dashboards shipped

| File | UID | Purpose |
|---|---|---|
| `grafana/dashboards/auction-realtime.json` | `lumen-auction-realtime` | ⭐ 12-panel primary dashboard. Maps to rubric 可观测性 line. Demo opens this. |
| `grafana/dashboards/ai-sidecar.json` | `lumen-ai-sidecar` | Doubao calls, tokens, fallback, ban-word hits. |
| `grafana/dashboards/chaos.json` | `lumen-chaos` | State of active fault injection — populated by `tools/chaos-runner/` at T9. |
| `grafana/dashboards/infra-base.json` | `lumen-infra-base` | Redis / MySQL / Go runtime underlay. |

All dashboards are auto-provisioned via `grafana/provisioning/dashboards.yaml`.

## Alert rules

Two tiers (per `prometheus/alerts.yml`):
- **critical**: rubric-line failures (seq gap, SLO breach, Redis/Bid-Engine/Timer down). 9 rules.
- **warn**: capacity / degradation (Stream lag, MySQL down, AOF stalls, AI circuit open). 6 rules.

P0 has no alertmanager wired — alerts surface as red/yellow panels in Grafana. P1 stretch: Slack webhook.

## Verification

```bash
# After `make up`:
curl -s http://localhost:9090/-/healthy   # Prometheus
curl -s http://localhost:3000/api/health  # Grafana

# Confirm metrics scraping:
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job, health}'

# Confirm alerts loaded:
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].rules[].name'

# Open dashboards:
open http://localhost:3000/d/lumen-auction-realtime
```

## Why this exists ahead of T1

Per [#14 v2 §7a](https://github.com/Eliaaazzz/live-auction-system/issues/14) + [PR #16 component doc 13-observability](https://github.com/Eliaaazzz/live-auction-system/blob/farizzz/structure-v2-component-breakdown/docs/components/13-observability.md), the rubric line **可观测性（竞拍状态监控、异常告警）** is one of the things mentor reviewers look at directly. T2 also explicitly needs a perf smoke that requires the dashboard live.

Landing this scaffolding ahead of T1 means:
1. The moment Eliaaazzz's T1 binary exposes `/metrics`, the dashboard lights up automatically.
2. T2 perf smoke has somewhere to compare ack/broadcast histograms against the SLO thresholds (already wired with red threshold lines).
3. T9 chaos drills have a state timeline dashboard ready to record.
4. Demo day, "show me your monitoring" → operator opens `lumen-auction-realtime` → 12 panels light up.

Metric names follow `docs/components/13-observability.md` § "Metrics catalog". If `apps/lumen/internal/metrics/` ships a name that doesn't match a panel here, the dashboard linter (`tools/dashboard-check/`, T0b) will catch it.
