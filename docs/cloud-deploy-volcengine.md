# 火山云生产部署 Runbook (Volcengine ECS + 云数据库 MySQL + 缓存 Redis)

> **Status:** stretch / 加分项 (FAQ §3, optional). The local `make up` path (#9/#87) stays
> the demo fallback — this is *additional* production evidence, not a replacement.
> **Method basis:** `docs/deploy-and-latency.md` (#112) — the server-side-SLO-vs-client-e2e
> measurement boundary applies here verbatim.
> 💰 **Cost:** 火山引擎 按量计费 ≈ ¥10–40/day (~¥25 typical) → ~¥350 for the challenge
> window. **余额可退；测/演示完务必关停 (A9).**
> 🔒 Secrets via `docs/secrets-workflow.md` — never commit/echo. Configs: `infra/docker-compose.prod.yml` + `infra/Caddyfile`.

## A0 — 账号 (队长, one-time)
1. 注册 + 实名认证: `https://console.volcengine.com/auth/login`.
2. 费用中心 → 充值 (按经济情况；余额可退)。

## A1 — 云服务器 ECS
产品服务 → 云服务器 → 创建实例:
- **计费**: 按量计费 (切记测完关停)。
- **地域/可用区**: 就近 (e.g. 华北2 北京)。**记下可用区** — MySQL/Redis 必须同 VPC+子网。
- **规格**: 2C4G 起步，**推荐 4C8G**。
- **镜像**: **Ubuntu 22.04 LTS**。
- **系统盘**: ≥ **40 GB**。
- **登录**: **SSH 密钥** (建密钥对，下载私钥；勿用密码)。
- **网络**: 默认创建「私有网络 (VPC)」+「子网」— 记下它们 (A2/A3 复用)。
- **安全组** (入方向规则):
  - `22/tcp` ← **仅你的出口 IP** (SSH)。
  - `80/tcp` + `443/tcp` ← `0.0.0.0/0` (Caddy: ACME + https/wss)。
  - 不开 `8080` 对公网 (Caddy 内网转发)。
- 创建后记录: **公网 IP** + **内网 IP**。

## A2 — 云数据库 MySQL 版
产品与服务 → 关系型数据库 → 云数据库 MySQL 版 → 创建:
- **网络**: 选 **与 ECS 相同的 VPC + 子网/可用区** (否则内网不通)。
- **白名单**: 加 **ECS 内网 IP** (`172.31.x.x`)。
- **账号**: 建高权限账号 + 库 `lumen` (字符集 utf8mb4)。
- 记下 **内网地址:端口** → 拼 DSN:
  `lumen:<pwd>@tcp(<rds_intranet_host>:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4`

## A3 — 缓存数据库 Redis 版
产品与服务 → NoSQL → 缓存数据库 Redis 版 → 创建:
- **网络/白名单**: 同 A2 (同 VPC+子网，白名单加 ECS 内网 IP)。
- **持久化**: 开 **AOF everysec** (V8/V9 冻结决策)。
- **节点规格**: 4G ≈ ¥0.66/hr，按目标选 (节点规格对费用影响最大)。
- 记下 **内网地址:端口** → `REDIS_ADDR=<redis_intranet_host>:6379`；若开启密码，另设 `REDIS_PASSWORD=<redis_pwd>`（不要把密码塞进 `REDIS_ADDR`）。

## A4 — ECS 装环境
```bash
ssh -i <key.pem> ubuntu@<ECS_PUBLIC_IP>
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker   # 免 sudo
git clone https://github.com/Eliaaazzz/live-auction-system.git && cd live-auction-system
```

## A5 — 生产配置 (secrets + 接管理实例)
`infra/docker-compose.prod.yml` 已是**独立**生产编排 (lumen + ai-sidecar + Caddy；MySQL/Redis 用 A2/A3 的托管实例)。在 ECS 上创建 `infra/.env.prod` (本地，**勿提交**):
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
FRONTEND_ORIGIN=https://<your-domain>
LUMEN_DOMAIN=<your-domain>
# 火山直播 (Part B；没配则直播间退回 sim sheen)
VOLCENGINE_LIVE_PUSH_DOMAIN=
VOLCENGINE_LIVE_PLAY_DOMAIN=
VOLCENGINE_LIVE_SIGN_KEY=
EOF
```
`config.go` §8 baseline 会校验: `APP_ENV=prod` 下必须非默认 JWT/evidence + `ENABLE_DEV_LOGIN=false` (compose 已设)。

## A6 — TLS + 反代 (wss)
- 在域名 DNS 处加 **A 记录**: `<your-domain>` → ECS 公网 IP (生效后 Caddy 才能签证书)。
- `infra/Caddyfile` 已配 auto-Let's-Encrypt + WS upgrade → `lumen:8080`。
- (浏览器生产 wss 必须 TLS — Caddy 自动签发/续期。)

## A7 — 起服 + 自检
```bash
set -a; . infra/.env.prod; set +a
docker compose -f infra/docker-compose.prod.yml up -d --build --wait
curl -sf https://<your-domain>/healthz && echo OK     # 期望 200
# 浏览器打开 https://<your-domain> → 走 wss 进直播间；seed 一个拍卖跑通出价
```

## A8 — 生产万人并发复测 (the win evidence)
从**异地机**(非 ECS)打 `wss://<your-domain>`，复用现成 harness:
- k6: `HOST_WS=wss://<your-domain> AID=<aid> TOKENS=.k6-tokens k6 run tools/loadtest/k6-ws.js`
- Locust: `python -m locust -f tools/loadtest/locustfile.py --headless -u 1500 -r 150 -t 60s --host wss://<your-domain>`
- Go load harness / sharded runs: set `TARGET=https://<your-domain>` and **use production login**, not dev-login:
  ```bash
  LOGIN_PATH=/api/login TARGET=https://<your-domain> LOAD_AUCTION_ID=<aid> \
    LOAD_RETRY_TOO_LOW=true LOAD_BIDS_PER_BIDDER=1 go run ./apps/lumen/cmd/lumen load
  ```
- 采集 **两套口径** (per #112): 服务端 SLO (`/metrics`，RTT-insulated: ack p95<80 / broadcast p95<150 / seqGap=0) + 客户端 e2e (真实 RTT) → 填 `docs/perf-report.md` §8。
- ⚠️ **不要为了压测重新打开 `ENABLE_DEV_LOGIN`**。生产 `POST /api/login` 只会签发 `role=user` 的普通买家 token；卖家/seed/load auction 应通过受控后台 seed、`seed-load`、或预先创建的 load auction 完成。跑完后删除临时 load auction/token artifacts；不要在 issue/日志里贴 token。

## A9 — 成本收尾
测/演示完: 控制台 **停止/释放** ECS + MySQL + Redis (按量计费持续扣费)。`docker compose -f infra/docker-compose.prod.yml down` 仅停容器，云资源要去控制台关。

## 验证 / 回滚
- ✅ `https://<domain>/healthz`=200；直播间 wss 可连；出价→ack；`/metrics` 可达。
- ✅ perf-report §8 填好 (服务端 SLO 在阈值内；e2e 记录真实 RTT)。
- ✅ **本地兜底不变**: `make up` 仍能离线跑完整 demo (#9/#87) — 生产部署绝不是演示单点。
- 回滚: `down` 容器 + 控制台关云资源；demo 回退本地。
