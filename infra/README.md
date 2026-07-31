# `infra/` — Local + demo infrastructure

This directory holds **infrastructure config files** that the docker-compose stack (lives in T0b PR) wires in. The Go binaries and web apps live in `apps/`; configs that they consume at runtime live here.

Currently shipped:
- `prometheus/` — scrape config, alert rules, recording rules
- `grafana/` — dashboards (JSON) + datasource + provisioning
- *(future)* `toxiproxy/`, `redis/`, `mysql/`, `nginx/` — land in their respective scope PRs

## Wiring into `docker-compose.yml` (already in this PR)

This PR already adds the four observability services to `infra/docker-compose.yml` under `profiles: [observability]` (search `^  prometheus:` to land at the block). They are dormant on default `make up` and activate via `make up-obs` / `docker compose --profile observability up -d --wait`.

> **Authoritative source = the YAML file itself**, not a snippet here. An earlier revision of this README inlined a snippet that drifted from the file (`depends_on: ai-sidecar` instead of `lumen: service_healthy`; `DATA_SOURCE_NAME` env instead of `--config.my-cnf` + `--mysqld.address`). To prevent that class of drift, this section now points at the file and only summarises what's there.

**Summary of what gets added** (4 services + 2 volumes, all profile-gated):

| Service | Image | Port | Depends on | Notes |
|---|---|---|---|---|
| `prometheus` | `prom/prometheus:v2.54.1` | `9090` | `lumen: service_healthy` | mounts `prometheus.yml` + `alerts.yml` + `recording.yml`; 7-day TSDB retention |
| `grafana` | `grafana/grafana:11.2.0` | `3000` | `prometheus` | anon Viewer enabled for demo; admin/lumen for editing; auto-provisions the 4 dashboards |
| `redis-exporter` | `oliver006/redis_exporter:v1.62.0` | `9121` | `redis: service_healthy` | env `REDIS_ADDR=redis://redis:6379` |
| `mysqld-exporter` | `prom/mysqld-exporter:v0.15.1` | `9104` | `mysql: service_healthy` | uses `--config.my-cnf=/etc/mysqld_exporter.my.cnf` + `--mysqld.address=mysql:3306` (v0.15+ dropped the `DATA_SOURCE_NAME` env); mounts `./mysql/mysqld_exporter.my.cnf:ro` |
| volume `prometheus-data` | — | — | — | TSDB persistence |
| volume `grafana-data` | — | — | — | dashboard/datasource provisioning + grafana state |

For the full YAML, open `infra/docker-compose.yml` and read the `prometheus:` / `grafana:` / `redis-exporter:` / `mysqld-exporter:` blocks. **Don't copy this README into another compose file** — point at the real one instead.

**Opt-in via profile** (`make up-obs` or `docker compose --profile observability up -d --wait`) — the default `make up` keeps the T1 stack lean (redis + mysql + ai-sidecar + lumen). After `--profile observability`, dashboards are at http://localhost:3000 (anon Viewer enabled for demo).

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
| `grafana/dashboards/auction-realtime.json` | `lumen-auction-realtime` | ⭐ 12-panel primary dashboard. Maps to the observability line in the rubric. Demo opens this. |
| `grafana/dashboards/ai-sidecar.json` | `lumen-ai-sidecar` | Doubao calls, tokens, fallback, ban-word hits. |
| `grafana/dashboards/chaos.json` | `lumen-chaos` | State of active fault injection — populated by `tools/chaos-runner/` at T9. |
| `grafana/dashboards/infra-base.json` | `lumen-infra-base` | Redis / MySQL / Go runtime underlay. |

All dashboards are auto-provisioned via `grafana/provisioning/dashboards.yaml`.

## Alert rules

Two tiers (per `prometheus/alerts.yml`):
- **critical**: rubric-line failures (seq gap, SLO breach, Redis/Bid-Engine/Timer down). 9 rules.
- **warn**: capacity / degradation (Stream lag, MySQL down, AOF stalls, AI circuit open). 6 rules.

P0 has no alertmanager wired — alerts surface as red/yellow panels in Grafana. P1 stretch: Slack webhook.

## What works today vs pending app instrumentation

**Working today** (`make up-obs` → 3/3 scrape targets green):
- `prometheus-self`, `redis` (via redis-exporter), `mysql` (via mysqld-exporter)
- All 4 dashboards load; Redis / MySQL / infra-base panels show real data
- `auction-realtime.json` panels referencing `lumen_*` metrics show "no data" until lumen exposes `/metrics`

**Pending app instrumentation** (commented out in `prometheus/prometheus.yml`):
- `lumen` scrape target — needs `promhttp.HandlerFor(reg, ...)` in `apps/lumen/cmd/lumen/main.go` (T-later; not blocking)
- `ai-sidecar` scrape target — needs same in `apps/ai-sidecar/cmd/sidecar/main.go`

When those binaries add a `/metrics` handler, uncomment the corresponding `scrape_configs` block in `prometheus.yml` (clearly labeled). Leaving them off avoids RED "scrape target down" state on the panels that already work.

## Verification

```bash
# After `make up-obs` (the observability profile):
curl -sf http://localhost:9090/-/healthy   # Prometheus → "Prometheus Server is Healthy."
curl -sf http://localhost:3000/api/health  # Grafana → {"database":"ok",...}

# Confirm scraping (expect 3 up):
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job, health}'

# Alerts loaded:
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].rules[].name'

# Open dashboards:
open http://localhost:3000/d/lumen-auction-realtime
```

## Why this exists ahead of T1

Per [#14 v2 §7a](https://github.com/Eliaaazzz/live-auction-system/issues/14) + [PR #16 component doc 13-observability](https://github.com/Eliaaazzz/live-auction-system/blob/farizzz/structure-v2-component-breakdown/docs/components/13-observability.md), the rubric line **observability (auction-state monitoring, anomaly alerting)** is one of the things mentor reviewers look at directly. T2 also explicitly needs a perf smoke that requires the dashboard live.

Landing this scaffolding ahead of T1 means:
1. The moment Eliaaazzz's T1 binary exposes `/metrics`, the dashboard lights up automatically.
2. T2 perf smoke has somewhere to compare ack/broadcast histograms against the SLO thresholds (already wired with red threshold lines).
3. T9 chaos drills have a state timeline dashboard ready to record.
4. Demo day, "show me your monitoring" → operator opens `lumen-auction-realtime` → 12 panels light up.

Metric names follow `docs/components/13-observability.md` § "Metrics catalog". If `apps/lumen/internal/metrics/` ships a name that doesn't match a panel here, the dashboard linter (`tools/dashboard-check/`, T0b) will catch it.
