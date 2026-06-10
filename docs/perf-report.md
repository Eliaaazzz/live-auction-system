# T8 Perf Report — Lumen Auction (V9 §4.2 P0 gate)

> **Status:** template — fill the §1 box-spec & §2 numbers AFTER `make load` runs on the team-deploy box.
> Source instrumentation: `apps/lumen/internal/metrics/`. Source harness: `apps/lumen/internal/server/load.go` (`lumen load`).
> SLO budget: V9 plan §4.2 (`ack p95 < 80 ms · broadcast p95 < 150 ms · hammer p95 < 500 ms · catchup 200 events < 1 s · 500 connected + 50 active, 60 s+ stable`).

---

## 1. Topology + box spec (V9 §4.3 required)

| Field | Value |
|---|---|
| Date | `YYYY-MM-DDTHH:MMZ` |
| Box | `<CPU model · cores · GHz>` · `<RAM>` · `<storage>` |
| OS / kernel | `<linux release>` / `<kernel>` |
| Go | `<go version>` |
| Redis | `redis:7-alpine` · `<config notes — AOF everysec>` · `<maxmemory>` |
| MySQL | `mysql:8` · `<my.cnf notes>` |
| Gateway topology | **1 gateway × 500 connections** (single-instance, matches `--mode=all`). Multi-gateway split is a T5/T9 follow-up. |
| Lumen build | `<git sha>` |
| Harness | `lumen load` (`infra/docker-compose.yml` `load` profile) — defaults below |
| Network | `<host-loopback | overlay>` — same-box compose; no WAN |

Harness defaults (§4.2 P0 gate):
- `LOAD_OBSERVERS=500`
- `LOAD_BIDDERS=50`
- `LOAD_SHARDS=1`
- `LOAD_DURATION_SEC=60`
- `LOAD_BID_INTERVAL_MS=100` (50 bidders × 10/s ≈ 500 bid/s aggregate)
- `LOAD_AUCTION_DUR_SEC=3600` (auction stays LIVE past the window → no hammer in the budget; record `hammerLatencyMs` only when a short-duration follow-up run hammers mid-window)
- `LOAD_OBSERVER_STAGGER_MS=10` (so the upgrade queue doesn't spike ack-p95 with a thundering herd)

---

## 2. Acceptance table (V9 §4.2 gate · 0-tolerance §4.1)

> Fill these from the `make load` stdout (the harness prints a `---- T8 load report ----` block). p95 is reservoir-sampled from `apps/lumen/internal/metrics.Histogram` over the full run.

| Metric | Budget (P0 gate) | Floor (P0 minimum) | Result | Pass/Fail |
|---|---|---|---|---|
| `BID_ACCEPTED` ack p95 | < 80 ms | < 200 ms | `_____ ms` | ⬜ |
| broadcast p95 (Bid Engine → last viewer) | < 150 ms | < 500 ms | `_____ ms` | ⬜ |
| hammer p95 (detection + Lua + fanout) | < 500 ms | < 2 s | `_____ ms` (n=`__`) | ⬜ |
| catchup (200 events) p95 | < 1 s | < 3 s | `_____ ms` (n=`__`) | ⬜ |
| `place_bid.lua` script_time p99 | < 5 ms | — (pre-gate, §4.2 footnote) | `_____ ms` | ⬜ |
| 500 connected + 50 active, 60 s+ stable | required | — | `_____ s observed` | ⬜ |
| seq gap | **0** | **0** | `__` | ⬜ |
| Verifier on post-load auction | `consistent` | — | `__________` | ⬜ |
| AOF fsync stalls observed | none > 50 ms | — | `__` | ⬜ |
| Go GC pauses (p99) | < 10 ms | — | `_____ ms` | ⬜ |

> Hammer SLO note: hammer measurement = `closeDue` detection lag + Lua exec (recorded in `hammerLatencyMs`) **plus** the AUCTION_SOLD broadcast-fanout latency (recorded in `broadcastLatencyMs`). The §4.2 budget is the sum; the report sums them in the P95-additive worst case (`hammer_p95_total ≈ hammerLatencyMs.p95 + broadcastLatencyMs.p95` for AUCTION_SOLD events). Long-duration default auctions never hammer inside the window; a separate `LOAD_AUCTION_DUR_SEC=30` run captures the hammer numbers without competing for the bid window.

---

## 3. Run output (paste-from-stdout)

```text
LOAD_AUCTION_IDS=auc_<...>,auc_<...>
LOAD_AUCTION_ID=auc_<...>
load config: observers=500 bidders=50 duration=60s bidInterval=100ms

---- T8 load report ----
auctions=auc_<...>,auc_<...> elapsed=<...>
topology(harness): observers=500 bidders=50 shards=1 bidInterval=100ms auctionDur=1h
bidder: sent=<N> acked=<N> rejected=<N> errors=<N>
observer: frames=<N> readErrors=<N> dialErrors=<N>
ack       p50=<ms> p95=<ms> p99=<ms> max=<ms> (count=<N>, budget p95<80ms)
broadcast p50=<ms> p95=<ms> p99=<ms> max=<ms> (count=<N>, budget p95<150ms)
hammer    p50=<ms> p95=<ms> p99=<ms> (count=<N>, budget p95<500ms)
catchup   p50=<ms> p95=<ms> p99=<ms> (count=<N>)
script    p50=<ms> p95=<ms> p99=<ms> (count=<N>, budget p99<5ms)
counters: bidsAccepted=<N> bidsRejected=<N> backpressureForceClose=<N> wsAuthUnauthorized=<N> wsSchemaMismatch=<N> wsUpgradeFailed=<N> seqGapCount=0 roomStatePatchEmitted=<N> roomStatePatchBids=<N> timerErrInternal=<N> timerErrInternalKeyType=<N> timerErrInternalSeqMismatch=<N> streamLenMax=<N> activeConns(end)=<N>
load: PASS
```

---

## 4. Tune notes (post-run · keep additive)

> Record any per-knob change made to bring a missed budget green. Anchor each change to the metric it moved (so the next runner can reproduce).

- `___ -> ___` because `____` (metric moved from `___` to `___` p95).
- ...

---

## 5. Verifier output (V9 §9 acceptance — must be `consistent`)

```text
consistent: stream=<N> mysql=<N> snapshot_seq=<N> (auction=auc_<...>)
```

If `mismatch_at_seq=...` or `hash_break_at_seq=...` appears: the load was post-load-trimmed past the diff range, or the persistence projection lagged the stream tail. Re-run with a longer settle gap before `make verify`. The MAXLEN trim is currently not enforced by the gateway — guard for T9 chaos.

---

## 6. Stretch / Super-stretch (非 P0 rehearsal)

| Metric | Stretch budget | Result |
|---|---|---|
| 500ms+ lane（ACK）p95 | < 800 ms | `_____` |
| 500ms+ lane（Broadcast）p95 | < 1000 ms | `_____` |
| Hammer p95（可重放窗口） | < 2000 ms | `_____` |
| Catchup 200 events p95（可重放窗口） | < 3000 ms | `_____` |
| Seq gap | = 0 | `_____` |

Run via:
```bash
LOAD_OBSERVERS=1000 LOAD_BIDDERS=100 LOAD_DURATION_SEC=60 make load
```

Super-stretch（100k / 2k / 4-shards）目标：
```bash
LOAD_100K_CONFIRM=1 make load-100k   # or true / yes / on
```
说明：100k 演练默认会做非 P0 自检门槛；仅在明确确认时执行（见 `LOAD_100K_CONFIRM`）。

如需**单房间** 10w 演练（固定到一个拍卖间，便于单-room fanout 极值压测）：
```bash
LOAD_100K_CONFIRM=1 make load-100k-single-room
```
对应二价模式：
```bash
LOAD_100K_CONFIRM=1 make load-100k-single-room-second-price
# 或
LOAD_100K_CONFIRM=1 make load-100k-single-room-vickrey
```

演练后可直接用产物目录做复核：

```bash
scripts/eval-load-100k-rehearsal.sh \
  --pack-dir .load-100k-rehearsals/<label> \
  --report .load-100k-rehearsals/<label>/eval-load-100k-rehearsal-summary.tsv
```

输出会给出每个 run 的 pass/fail 与汇总（包括 observer/seq/backpressure 是否越线、每轮 bidder sent/acked 下限是否达标），便于将
`summary.tsv` 与复盘清单打通。`--report` 会把同样的汇总结果持久化为固定文件。

如需演练二价（Vickrey）模式，可设置 `LOAD_AUCTION_MODE=VICKREY`（或 `LOAD_AUCTION_MODE=second_price` / `LOAD_AUCTION_MODE=second price` / `LOAD_AUCTION_MODE=second` / `LOAD_AUCTION_MODE=vickrey` / `LOAD_AUCTION_MODE=auction2` / `LOAD_AUCTION_MODE=2`）。
如需显式一价（English）模式，可设置 `LOAD_AUCTION_MODE=ENGLISH`（或 `LOAD_AUCTION_MODE=first_price` / `LOAD_AUCTION_MODE=first price` / `LOAD_AUCTION_MODE=first` / `LOAD_AUCTION_MODE=firstprice`）。
`load-100k` 也支持该变量，`load-100k-rehearse` 会沿用该变量透传，例如：
```bash
LOAD_AUCTION_MODE=VICKREY LOAD_100K_CONFIRM=1 make load-100k
make load-second-price
make load-smoke-second-price
make load-smoke-vickrey
```
你也可以直接调用现有 wrapper：
```bash
LOAD_100K_CONFIRM=1 make load-100k-second-price
LOAD_100K_CONFIRM=1 make load-100k-vickrey
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-second-price-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-vickrey-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-rehearsal-second-price
```
对应的单房间复盘可直接走固定别名（会覆盖为 `--shards 1`）：
```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-single-room-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-single-room-second-price-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-single-room-vickrey-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --auction-mode VICKREY" \
  make load-100k-single-room-second-price-gate
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --auction-mode VICKREY" \
  make load-100k-single-room-vickrey-gate
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --auction-mode VICKREY" \
  make load-100k-single-room-rehearsal-gate
```
日常可直接执行：
```bash
make load-vickrey               # P0 lane, Vickrey alias for second-price
make load-100k-vickrey          # super-stretch, Vickrey alias
```
对应脚本写法可直接加参数：
```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --auction-mode VICKREY" \
  make load-100k-rehearse
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --auction-mode VICKREY --shards 1" \
  make load-100k-rehearse
```
若后端 REST 与 WebSocket 入口不共用域名（如域名前置/回源不同），可同时覆盖 WS 地址：
```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d) --base-ws-url wss://ws.example.com" \
  make load-100k-rehearse
```
如需在低资源上临时放行前置检查，可设置 `LOAD_100K_ALLOW_LOW_ULIMIT=1` / `true` / `yes` / `on`（仅限明确知道风险时）
或 `LOAD_100K_ALLOW_LOW_EPHEMERAL=1` / `true` / `yes` / `on`。
（如需固定预算覆写，直接传入 LOAD_* 环境变量；当前 `make load-100k` 默认会写入：
`LOAD_ACK_P95_MS=800`、`LOAD_BROADCAST_P95_MS=1000`、`LOAD_HAMMER_P95_MS=2000`、`LOAD_CATCHUP_P95_MS=3000`、`LOAD_SCRIPT_P99_MS=20`）
```bash
LOAD_OBSERVERS=100000 LOAD_BIDDERS=2000 LOAD_SHARDS=4 \
LOAD_AUCTION_DUR_SEC=3600 LOAD_BID_INTERVAL_MS=100 \
LOAD_ACK_P95_MS=800 LOAD_BROADCAST_P95_MS=1000 \
LOAD_HAMMER_P95_MS=2000 LOAD_CATCHUP_P95_MS=3000 \
LOAD_SCRIPT_P99_MS=20 LOAD_OBSERVER_STAGGER_MS=0 make load
```
  
非 P0 演练打包（建议）：
```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-$(date +%Y%m%d)" \
  make load-100k-rehearse
```
脚本会落库存为：
- `manifest.json`
- `preflight/status.tsv`（包含 `ulimit` / `ip_local_port_range` / `result`）
- `summary.tsv`
- `health-start.json` / `health-end.json`
- 每次运行的 `runs/<run-id>/load.log` + `runs/<run-id>/metrics.txt`
- `manifest.json` 内会保留每次演练的参数预算（`budgets_ms`/`observer_stagger_ms`/`attempt_interval_sec`）以及运行元信息（命令行、仓库 commit、主机）、`auction_mode`（`first_price` / `second_price`，其中别名如 `ENGLISH` / `VICKREY` 会先归一化成对应 canonical 值）用于后续对账时避免“同参数复用”误差。
- `summary.tsv` 的每行会补齐该次 run 的 `run_dir`、`log_file`、`metrics_file`，可直接跳到对应文件（`runs/<run-id>/...`）确认每次指标与原始输出。

如需把断线回放校验并入同一套打点，可加 `--catchup-smoke`：

```bash
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --catchup-smoke --label superstretch-$(date +%Y%m%d)" \
  make load-100k-rehearse
```

开启后每个 run 会额外产出 `runs/<run-id>/catchup.log`，并在 `summary.tsv` / `manifest.json` 里记录 `catchup_status` / `catchup_rc` / `catchup_log`，以及 `catchup_checks` 汇总字段。

便于后续并发证明归档。

如果演练场已确认 schema 版本，也可把 `ws-schema-precheck.mjs` 一并并入同一跑批：

```bash
  # 注意：--base-ws-url 传「WebSocket base」即可，不要再附带 /ws（脚本会自动拼接）
  LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --catchup-smoke --ws-precheck --base-ws-url wss://ws.example.com" \
    make load-100k-rehearse
```

如需显示固定版本号，可加 `WS_PRECHECK_SCHEMA=<n>`（缺省从 `SCHEMA_VERSION` 读取）；如需 Token 鉴权场景，可再加 `WS_PRECHECK_TOKEN=<token>` 与 `WS_PRECHECK_TIMEOUT_MS=<ms>`；如需强制用某个拍卖做前置检查可加 `--ws-precheck-auction <auction-id>`。  
  `--ws-precheck` 也可独立运行（不加 `--catchup-smoke` 时只做 schema 前置校验、并产出 `runs/<run-id>/ws-schema-precheck.log`，`summary.tsv` 会记录 `ws_precheck_status` / `ws_precheck_rc` / `ws_precheck_log` 与 `manifest.json` 的 `ws_precheck_checks`）。

Stretch failure is **not** a P0 gate failure (V9 §4.2 explicit).

If you perform a public remote rehearsal for a distributed run, execute the
end-to-end sequence in [docs/deploy-rehearsal-card.md](deploy-rehearsal-card.md)
to keep server-side and client-side evidence boundaries explicit.

For repeated local load-smoke checks with one summary artifact:

```sh
REPEAT_LOAD_SMOKE_ARGS="--attempts 3 --interval 5 --json --strict" \
  make load-smoke-repeat

# Optional: auto-clean `auc_load_*` IDs after each run (dry-run recommended first)
REPEAT_LOAD_SMOKE_ARGS="--attempts 3 --interval 5 --json --cleanup-load --cleanup-load-dry-run --cleanup-load-scan-suffix auc_load_" \
  make load-smoke-repeat
```

For a single-shot operator flow, use:

```sh
BASE_URL="https://your-domain" \
  BASE_WS_URL="wss://ws.example.com" \
  make deploy-perf-rehearsal \
  DEPLOY_REHEARSAL_TARGET=500 \
  DEPLOY_REHEARSAL_AID=auc_demo \
  PERF_GATE_CLIENT_SUMMARY=./client-summary.json \
  PERF_GATE_OUT_DIR=./rehearsal-perf
```

After the rehearsal, run a lightweight catchup/smoke handshake witness:

```sh
WEB_SMOKE_AID="auc_demo" \
WEB_SMOKE_BASE_URL="$BASE_URL" \
BASE_WS_URL="$BASE_WS_URL" \
make web-smoke-catchup
```

If the rehearsal room is already second-price, use:

```sh
BASE_URL="https://your-domain" \
  DEPLOY_REHEARSAL_SECOND_PRICE_AID=auc_vickrey \
  make deploy-perf-rehearsal-second-price
```

For evidence-only remote checks:

```sh
BASE_URL="https://your-domain" \
  DEPLOY_REHEARSAL_REPORT_ONLY=1 \
  make deploy-perf-rehearsal
```

For super-stretch evidence-only:

```sh
BASE_URL="https://your-domain" \
  DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1 \
  DEPLOY_REHEARSAL_100K_REPORT_ONLY=1 \
  make deploy-perf-rehearsal-100k
```

Super-stretch Vickrey path（演练前提是演练房间已按二价规则创建）：

```sh
BASE_URL="https://your-domain" \
  DEPLOY_REHEARSAL_100K_SECOND_PRICE_AID=auc_vickrey \
  DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1 \
  make deploy-perf-rehearsal-100k-second-price
```

`DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1` is enabled by default in
`deploy-perf-rehearsal-100k` and aligns the schema gate with the super-stretch
profile.

If `DEPLOY_REHEARSAL_100K_REPORT_ONLY` is not set, it defaults to
`DEPLOY_REHEARSAL_REPORT_ONLY`.

Record `result: FAIL-REPORTED` as a non-blocking signal in
`perf-gate/summary.md` for these evidence-only runs.

For manual remote-load scenarios that dump metrics after peak load, set:

```sh
DEPLOY_REHEARSAL_METRICS=/path/to/peak-metrics.json
```

If omitted, `deploy-perf-rehearsal` uses preflight `metrics/body.txt`.

For a non-P0 100k-tier remote lane, use the super-stretch wrapper:

```sh
BASE_URL="https://your-domain" \
  BASE_WS_URL="wss://ws.example.com" \
  make deploy-perf-rehearsal-100k \
  DEPLOY_REHEARSAL_100K_TARGET=100000 \
  DEPLOY_REHEARSAL_100K_AID=auc_demo \
  DEPLOY_REHEARSAL_100K_ACK_P95_MAX_MS=800 \
  DEPLOY_REHEARSAL_100K_BROADCAST_P95_MAX_MS=1000 \
  DEPLOY_REHEARSAL_100K_HAMMER_P95_MAX_MS=2000 \
  DEPLOY_REHEARSAL_100K_CATCHUP_P95_MAX_MS=3000 \
  PERF_GATE_CLIENT_SUMMARY=./client-summary.json \
PERF_GATE_OUT_DIR=./rehearsal-perf-100k
```

### 外部压测机 100k 演练（server-side SLO 门控）速查清单

如果你必须在外部机器跑 `load-100k`（与 #112 对齐的非本地演练口径），可按以下两步复用同一份 run 包：

```sh
# Step 1: 跑 100k 演练并用 label 归档
RUN_LABEL="superstretch-$(date +%Y%m%dT%H%M%SZ)"
BASE_URL="https://api.example.com" \
BASE_WS_URL="wss://ws.example.com" \
LOAD_100K_REHEARSAL_LABEL="${RUN_LABEL}" \
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json" \
  make load-100k-rehearsal-gate

# Step 2: 该目标会自动读取 ${RUN_LABEL} 下最近一次 run 的 metrics.txt 做服务端门控，并继续执行 summary 复核；
# 二价模式固定入口（目标房间已按二价模式配置）：
RUN_LABEL="superstretch-v2-$(date +%Y%m%dT%H%M%SZ)"
LOAD_100K_REHEARSAL_LABEL="${RUN_LABEL}" \
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --auction-mode VICKREY" \
  make load-100k-rehearsal-gate-second-price
RUN_LABEL="superstretch-single-room-v2-$(date +%Y%m%dT%H%M%SZ)"
LOAD_100K_REHEARSAL_LABEL="${RUN_LABEL}" \
LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --auction-mode VICKREY" \
  make load-100k-single-room-rehearsal-gate
# 若要单独复核 summary，可直接运行：
# LOAD_100K_REHEARSAL_EVAL_LABEL="${RUN_LABEL}" make load-100k-eval
# 观测证据可补充：
# LOAD_100K_REHEARSAL_CLIENT_SUMMARY=/path/to/client-summary.json
```

说明：
- `load-100k-rehearsal-gate` 会读取最新 run 的 `metrics.txt`，把 `ackLatencyMs` / `broadcastLatencyMs` 等服务端指标做后端硬闸。
- 可选：设置 `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL` / `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_KEY_TYPE` / `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH` 为非空整数（例如 `0`）可把对应 timer 异常计数列入本地 `load-100k` 门禁。
- `load-100k-eval` 会顺序复核 `summary.tsv` 行级指标（如 readErrors、dialErrors、seqGap、backpressure）与可选重放检查状态。
- `LOAD_100K_REHEARSAL_CLIENT_SUMMARY` 可接入 k6/wsload/jMeter 观测摘要；缺失时只做服务端硬闸，仍可通过。
- 演练打包默认落到 `.load-100k-rehearsals/${RUN_LABEL}`（含 `manifest.json`、`summary.tsv`、`runs/*/metrics.txt`）。
- `LOAD_100K_REHEARSAL_GATE_OUT_DIR` 可覆盖 `remote-perf-gate.sh` 输出目录（默认同目录下 `perf-gate`）。

---

## 7. Reproduce

```bash
# full P0 gate
make load            # 500/50/60s + post-load verify (~90 s including build)

# repeated load smoke run + aggregate summary (recommended for trend checks)
REPEAT_LOAD_SMOKE_ARGS="--attempts 5 --interval 2 --json" \
  make load-smoke-repeat
# JSON output includes seqGapCount/backpressureForceClose, websocket counters,
# and timer corruption counters (`timerErrInternal*`) in `totals`.

# CI-cheap regression smoke (same code, smaller N)
make load-smoke      # 25/5/10s + post-load verify (~25 s)

# inspect live counters
curl -s http://localhost:8080/metrics | jq
```
