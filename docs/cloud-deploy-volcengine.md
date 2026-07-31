# Volcengine production deployment runbook (Volcengine ECS + managed MySQL + managed Redis)

> **Status:** stretch / bonus item (FAQ §3, optional). The local `make up` path (#9/#87) remains
> the demo fallback — this is *additional* production evidence, not a replacement.
> **Method basis:** `docs/deploy-and-latency.md` (#112) — the server-side-SLO-vs-client-e2e
> measurement boundary applies here verbatim.
> 💰 **Cost:** Volcengine pay-as-you-go ≈ ¥10–40/day (~¥25 typical) → ~¥350 for the challenge
> window. **The balance is refundable; always shut everything down after testing/demoing (A9).**
> 🔒 Secrets go through `docs/secrets-workflow.md` — never commit or echo them. Manual compose configs: `infra/docker-compose.prod.yml` + `infra/Caddyfile`; GitHub Actions CD uses a runner-built systemd runtime and does not start Caddy.

## A0 — Account (team lead, one-time)
1. Register and complete real-name verification: `https://console.volcengine.com/auth/login`.
2. Billing Center → top up (as your budget allows; the balance is refundable).

## A1 — ECS instance
Products & Services → Elastic Compute Service → Create Instance:
- **Billing**: pay-as-you-go (remember to shut it down when done).
- **Region/AZ**: pick a nearby one (e.g. North China 2, Beijing). **Note the AZ down** — MySQL/Redis must be in the same VPC + subnet.
- **Spec**: 2C4G minimum, **4C8G recommended**.
- **Image**: **Ubuntu 22.04 LTS**.
- **System disk**: ≥ **40 GB**.
- **Login**: **SSH key** (create a key pair and download the private key; do not use a password).
- **Network**: it creates a default VPC plus subnet — note them down (reused in A2/A3).
- **Security group** (inbound rules):
  - `22/tcp` ← **your egress IP only** (SSH).
  - `80/tcp` + `443/tcp` ← `0.0.0.0/0` (Caddy: ACME + https/wss).
  - Do not expose `8080` publicly (Caddy forwards internally).
- After creation, record the **public IP** and the **private IP**.

## A2 — Managed MySQL
Products & Services → Relational Database → MySQL → Create:
- **Network**: choose **the same VPC + subnet/AZ as the ECS instance** (otherwise the private network will not route).
- **Allowlist**: add the **ECS private IP** (`172.31.x.x`).
- **Account**: create a privileged account plus the `lumen` database (charset utf8mb4).
- Note the **private address:port** → assemble the DSN:
  `lumen:<pwd>@tcp(<rds_intranet_host>:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4`

## A3 — Managed Redis
Products & Services → NoSQL → Redis → Create:
- **Network/allowlist**: same as A2 (same VPC + subnet, add the ECS private IP to the allowlist).
- **Persistence**: enable **AOF everysec** (a frozen V8/V9 decision).
- **Node spec**: 4G ≈ ¥0.66/hr, pick per your target (node spec dominates the cost).
- Note the **private address:port** → `REDIS_ADDR=<redis_intranet_host>:6379`; if a password is enabled, set `REDIS_PASSWORD=<redis_pwd>` separately (do not stuff the password into `REDIS_ADDR`).

## A4 — Install the environment on ECS
```bash
ssh -i <key.pem> ubuntu@<ECS_PUBLIC_IP>
sudo apt-get update && sudo apt-get install -y git
# Only needed for the manual compose+Caddy path in A6/A7:
sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker   # manual compose only
git clone https://github.com/Eliaaazzz/live-auction-system.git && cd live-auction-system
```

## A5 — Production config (secrets + managed instances)
Create `infra/.env.prod` on the ECS box (local only, **do not commit it**). GitHub Actions CD keeps this file in `CD_REMOTE_DIR`; the manual compose path also reads it before starting `infra/docker-compose.prod.yml`:
```bash
cat > infra/.env.prod <<'EOF'
MYSQL_DSN=lumen:<pwd>@tcp(<rds_intranet>:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4
# Alternative to MYSQL_DSN for managed MySQL consoles that expose split fields:
# MYSQL_HOST=<rds_intranet>
# MYSQL_PORT=3306
# MYSQL_USER=lumen
# MYSQL_PASSWORD=<mysql_pwd>
# MYSQL_DATABASE=lumen
# MYSQL_TLS=skip-verify
REDIS_ADDR=<redis_intranet>:6379
REDIS_PASSWORD=<redis_pwd_if_enabled>
JWT_SECRET=<openssl rand -hex 32>
EVIDENCE_HMAC_KEY=<openssl rand -hex 32>
METRICS_RESET_TOKEN=<openssl rand -hex 32>
FRONTEND_ORIGIN=https://<your-domain>
LUMEN_DOMAIN=<your-domain>
# deploy identity for GET /version; set these at deploy time, not manually forever
LUMEN_BUILD_SHA=unknown
LUMEN_BUILD_TIME=unknown
# Volcengine Live (Part B; if unset, the room falls back to the simulated sheen)
VOLCENGINE_LIVE_PUSH_DOMAIN=
VOLCENGINE_LIVE_PLAY_DOMAIN=
VOLCENGINE_LIVE_SIGN_KEY=
EOF
```
The `config.go` §8 baseline validates that under `APP_ENV=prod` the JWT/evidence secrets are non-default and `ENABLE_DEV_LOGIN=false` (compose already sets this).

Before every deploy, export the current build identity so `/version` can catch stale binaries before a public load test:

```bash
export LUMEN_BUILD_SHA=$(git rev-parse --short HEAD)
export LUMEN_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## A5.5 — GitHub Actions CD
Production CD is wired by `.github/workflows/deploy-prod.yml`. The workflow builds Linux binaries and web assets on the runner, then uploads release archives to ECS over checksum-verified chunked SSH before restarting the systemd services.

Required repository secrets:
- `CD_ECS_HOST`: Volcengine ECS public IP or DNS name.
- `CD_ECS_USER`: SSH user with root access or passwordless sudo, for example Ubuntu's default `ubuntu` user after `sudo -n true` succeeds.
- `CD_ECS_SSH_KEY`: private key for that SSH user.
- `CD_ECS_PORT`: optional SSH port; defaults to `22`.

Optional repository variables:
- `CD_BASE_URL`: post-deploy smoke base URL; defaults to `http://115.191.76.40`.
- `CD_REMOTE_DIR`: source/config directory on ECS; defaults to `~/live-auction-system`.
- `CD_AUTO_DEPLOY`: set to `true` only when main should deploy automatically after CI success.

The workflow keeps runtime secrets in `infra/.env.prod` on ECS, checks out the exact CI-tested commit for auto deploys, builds Linux binaries and the web bundle on the GitHub runner, uploads them to `/opt/lumen-runtime`, updates `LUMEN_BUILD_SHA` and `LUMEN_BUILD_TIME`, then restarts. Runtime install and systemd writes use root or passwordless sudo. This Actions path serves the app directly from `lumen.service` on HTTP port 80; it does **not** start `infra/docker-compose.prod.yml` or Caddy. Use `CD_BASE_URL=http://<ECS_PUBLIC_IP>` unless you separately put a TLS reverse proxy in front.

```bash
systemctl restart lumen-sidecar.service
systemctl restart lumen.service
```

It gates the deploy with `/healthz`, `/version`, and `/metrics`. `/version.buildSha` must match the deployed commit or the workflow fails.

## A6 — TLS + reverse proxy (manual compose/Caddy path)
- Add an **A record** at your DNS provider: `<your-domain>` → the ECS public IP (Caddy can only issue a certificate once it resolves).
- `infra/Caddyfile` belongs to the manual `docker compose -f infra/docker-compose.prod.yml` path and reverse-proxies to the compose service `lumen:8080`. The GitHub Actions systemd CD path above does not start Caddy.
- (Browser-side production wss requires TLS — use the Caddy compose path or another explicit reverse proxy in front of the systemd service.)

## A7 — Start via manual compose + self-check
```bash
set -a; . infra/.env.prod; set +a
export LUMEN_BUILD_SHA=$(git rev-parse --short HEAD)
export LUMEN_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f infra/docker-compose.prod.yml up -d --build --wait
curl -sf https://<your-domain>/healthz && echo OK     # expect 200
curl -sf https://<your-domain>/version               # schemaVersion + buildSha must match current deploy
# Open https://<your-domain> in a browser → enter a room over wss; seed an auction and place a bid end to end
```

Do not start a public 10k run until `/version.buildSha` matches `git rev-parse --short HEAD` and a current-schema WS smoke has proved `ROOM_JOIN -> ROOM_SNAPSHOT` and `BID_PLACE -> BID_ACCEPTED` on a LIVE auction. For Actions CD without TLS, use `http://<ECS_PUBLIC_IP>` / `ws://<ECS_PUBLIC_IP>` targets; for domain HTTPS/wss, use the explicit Caddy/proxy path above.

## A8 — Production 10k-concurrency re-measurement (the win evidence)
Drive `wss://<your-domain>` from an **out-of-region machine** (not the ECS box), reusing the existing harnesses:
- k6: `HOST_WS=wss://<your-domain> AID=<aid> TOKENS=.k6-tokens k6 run tools/loadtest/k6-ws.js`
- Locust: `python -m locust -f tools/loadtest/locustfile.py --headless -u 1500 -r 150 -t 60s --host wss://<your-domain>`
- Go load harness / sharded runs: set `TARGET=https://<your-domain>` and **use production login**, not dev-login:
  ```bash
  LOGIN_PATH=/api/login TARGET=https://<your-domain> LOAD_AUCTION_ID=<aid> \
    LOAD_RETRY_TOO_LOW=true LOAD_BIDS_PER_BIDDER=1 go run ./apps/lumen/cmd/lumen load
  ```
- Collect **both measurement views** (per #112): server-side SLO (`/metrics`, RTT-insulated: ack p95<80 / broadcast-or-roomStatePatch p95<150 / seqGap=0) plus client e2e (real RTT) → fill in `docs/perf-report.md` §8.
- ⚠️ **Do not re-enable `ENABLE_DEV_LOGIN` just to run a load test.** Production `POST /api/login` only issues an ordinary buyer token with `role=user`; seller/seed/load auctions should be created through a controlled backend seed, `seed-load`, or a pre-created load auction. Delete temporary load auctions and token artifacts afterwards, and never paste tokens into issues or logs.

### A8.1 — 10k acceptance from an independent worker near Beijing
The final 10k evidence must come from an independent Linux load worker; the gateway ECS must not dial its own public IP. The recommended setup is to spin up 2 temporary 2c/4g-or-larger ECS instances in the same Volcengine Beijing VPC, allow only the controller's SSH to reach the workers, and have the workers target the gateway's private IP or a private LB, e.g. `ws://172.31.12.98:80`. That avoids the public hairpin/NAT connection failures while client RTT still represents traffic near Beijing.

Controller preparation:
- `/version.buildSha` already matches the commit under acceptance, `/healthz` is healthy, and the current LIVE load auction can do `ROOM_JOIN -> ROOM_SNAPSHOT` and `BID_PLACE -> BID_ACCEPTED`.
- `TOKENS_FILE` holds at least 10,000 production buyer tokens; never write token contents into an issue, PR, or shell output.
- `METRICS_RESET_TOKEN` is passed only through an environment variable, used to get clean run-window metrics.
- `VERIFY_CMD` points at the Replay Verifier on the production gateway, to accept `stream == mysql == snapshot_seq`.

Example:

```bash
cat >/tmp/lumen-wsload-hosts.tsv <<'EOF'
00 root@<beijing-worker-0-private-ip>
01 root@<beijing-worker-1-private-ip>
EOF

RUNNER_REGION=cn-beijing \
BASE_URL=http://<gateway-public-ip> \
WS_HOST=ws://<gateway-private-ip>:80 \
TOKENS_FILE=/opt/lumen-load/tokens-current.txt \
LOAD_AUCTION_ID=<live-load-auction-id> \
METRICS_RESET_TOKEN="$METRICS_RESET_TOKEN" \
VERIFY_CMD='ssh root@<gateway-public-ip> "LUMEN_SOURCE_DIR=/opt/live-auction-system /opt/lumen-runtime/run-lumen.sh verify --auction \"$LOAD_AUCTION_ID\""' \
scripts/beijing-wsload-remote-10k-evidence.sh \
  --hosts /tmp/lumen-wsload-hosts.tsv \
  --wsload-bin ./tools/loadtest/wsload/wsload-linux
```

Pass criteria:
- Remote worker aggregate: `connect_ok=10000`, `connect_fail=0`, `closed_early=0`.
- Server metrics gate: `activeConns` reaches 10k; `ackLatencyMs.p95 < 80ms`; `roomStatePatchLatencyMs.p95 < 150ms`; `seqGapCount=0`; `backpressureForceClose=0`.
- Replay Verifier: consistent, with `stream/mysql/snapshot_seq` three-way agreement recorded.

## A9 — Cost wrap-up
After testing/demoing: **stop or release** ECS + MySQL + Redis in the console (pay-as-you-go keeps billing). `docker compose -f infra/docker-compose.prod.yml down` only stops containers — the cloud resources must be shut down in the console.

## Verification / rollback
- ✅ Actions CD: `http://<ECS_PUBLIC_IP>/healthz`=200 and `/version.schemaVersion` + `/version.buildSha` match the intended deploy. Manual Caddy path: `https://<domain>/healthz`=200, wss connects, bid→ack works. `/metrics` is reachable.
- ✅ perf-report §8 is filled in (server-side SLO within thresholds; e2e records real RTT).
- ✅ **The local fallback is unchanged**: `make up` still runs the full demo offline (#9/#87) — production deployment is never a single point of failure for the demo.
- Rollback: bring the containers `down` and shut the cloud resources off in the console; fall the demo back to local.
