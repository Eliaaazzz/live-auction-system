# Deploy rehearsal operator card

This card turns the deploy, media, and remote performance helpers into one
operator path for a remote auction rehearsal. It is intended to reduce PR-comment
hunting during the #112/#121 rehearsal work and keep the evidence boundary clear.

可复用签名模板见：`docs/rehearsal-closure-checklist.md`。
若直接提审计闭环 issue，可选择 `.github/ISSUE_TEMPLATE/rehearsal-closure.md` 作为模板。

## Scope

Use this when rehearsing a public or remote Lumen Auction stack before claiming a
larger concurrency tier.

## Evidence naming contract (required fields)

To keep every rehearsal replayable from one path, use this fixed naming map:

- Remote rehearsal root: `DEPLOY_REHEARSAL_OUT_DIR` (default `.deploy-rehearsal-<timestamp>`)
  - Preflight: `<root>/manifest.txt`, `<root>/status.tsv`, route artifacts under `<root>/<route-name>/`
  - Remote perf gate: `<root>/perf-gate/summary.md`, `<root>/perf-gate/gate.tsv`
  - Optional second-price proof: `<root>/verify-second-price-payment-summary.tsv`
- Super-stretch local rehearsal root: `LOAD_100K_REHEARSAL_PACK_DIR/<label>` (default `.load-100k-rehearsals/<label>`)
  - Core pack: `<pack>/manifest.json`, `<pack>/summary.tsv`
  - Local preflight: `<pack>/preflight/status.tsv` (optional, written by `load-100k-preflight` path)
  - Super-stretch gate: `<pack>/perf-gate/summary.md`, `<pack>/perf-gate/gate.tsv` (`load-100k-rehearsal-gate`)
  - Optional second-price proof: `<pack>/verify-second-price-payment-summary.tsv`

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

Before each run, capture owner/deadline metadata for auditability:

- Owner:
- Operator deadline:
- Rehearsal target concurrency:
- Evidence directory:
- Hard close conditions (must be satisfied before final close):
  - preflight: public route checks PASS and manifest/status captured (`manifest.txt`, `status.tsv`, route artifacts)
  - preflight: if `EXPECTED_BUILD_REVISION` is set, `version_revision_check` in `deploy-rehearsal-check` must pass
  - remote/perf gate: PASS (or explicit FAIL-REPORTED only when report-only)
  - load/rehearsal pack: `summary.tsv` + `manifest.json` + run `load.log` + `metrics.txt` + health snapshots present
  - ws schema: schema precheck PASS when required, or explicitly documented as out of scope
  - replay/consistency: verifier green (`make verify` + `make verify-evidence`) OR documented catchup/ws-precheck pass
  - evidence: operator note includes exact commit, timestamp, target URL/stack, and hard-fail rationale for skipped gates

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
   EXPECTED_BUILD_REVISION="$(git rev-parse HEAD)" \
   scripts/deploy-preflight.sh
   ```

   Retain `manifest.txt`, `status.tsv`, route response artifacts, and
   `metrics-summary.json`. The helper reads public endpoints:
   `/healthz`, `/version`, `/metrics`, `/admin.html`, `/room.html?auction=$AID`,
   and `/ws`. By default it expects auth-gated response `401/403`; if `WS_PRECHECK_TOKEN=<token>`
   is set it also accepts a valid upgrade `101` for token-authenticated endpoints. If you want
   a strict handshake-only check, set `REQUIRE_WS_UPGRADE=true` (or `1`/`yes`/`on`) as well.
   When `EXPECTED_BUILD_REVISION` is provided, preflight also verifies `/version`
   build revision and prints a summary line `version check: PASS/FAIL`, while
   `manifest.txt` records `version_revision_actual`, `version_revision_match`, and
   `version_revision_result`.
   Optional: set `EXPECTED_WS_SCHEMA="${SCHEMA_VERSION:-1}"` (or explicit number) to
   fail the preflight when `/version`'s `wsSchema` drifts; this writes
   `version_ws_schema_actual`, `version_ws_schema_match`, and
   `version_ws_schema_result` to `manifest.txt`.

   Optional schema precheck:

   ```sh
   BASE_URL="$BASE_URL" \
   BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
   AID=auc_demo \
   REQUIRE_HTTPS=1 \
   REQUIRE_WS_SCHEMA_CHECK=true \
   WS_PRECHECK_SCHEMA="${SCHEMA_VERSION:-1}" \
   WS_PRECHECK_TOKEN="..." \
   scripts/deploy-preflight.sh
   ```

   This opens an actual websocket handshake, sends `ROOM_JOIN`, and validates the
   first schema-bearing server message against `WS_PRECHECK_SCHEMA` at the `/ws` route.
   `BASE_WS_URL` should be the websocket base host (no `/ws` suffix; it is
   appended automatically). Use this for
   remote rehearsals where frontend/backend drift is a known risk.

   For super-stretch paths, `make deploy-perf-rehearsal-100k` enables this check
   by default (`DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1`).

   Optional hard acceptance smoke (recommended before/after large-scale runs) to
   directly capture `ROOM_JOIN -> BID_PLACE -> BID_ACCEPTED`:

   ```sh
   cd apps/web
   WEB_SMOKE_AID="auction-id-under-test" \
   HOST_HTTP="$BASE_URL" \
   HOST_WS="${BASE_WS_URL:-wss://ws.example.com}" \
   npm run -s smoke:catchup | tee "./live-bid-smoke.log"
   ```

   - `HOST_WS` is the websocket base host (for example `wss://ws.example.com`).
     Do not append `/ws`.
   - PASS is `TC-T6-102 catchup smoke PASSED` and a zero exit code.
   - Mark this as evidence in the closure checklist before `overall` passes.

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
DEPLOY_REHEARSAL_100K_SECOND_PRICE_AID=auc_vickrey \
make deploy-perf-rehearsal-100k-second-price
```

如果你要固定做单房间十万并发（更贴近 #112 的核心目标），可以指定单房间 aid + coalesced patch 门槛：

```sh
BASE_URL="$BASE_URL" \
BASE_WS_URL="${BASE_WS_URL:-$BASE_URL}" \
DEPLOY_REHEARSAL_100K_SINGLE_ROOM_AID=auc_single_room_vickrey \
DEPLOY_REHEARSAL_100K_SINGLE_ROOM_ROOM_STATE_PATCH_MIN_EMITTED=1 \
DEPLOY_REHEARSAL_100K_SINGLE_ROOM_ROOM_STATE_PATCH_MIN_BIDS=1 \
make deploy-perf-rehearsal-100k-single-room-second-price
```

上述会在 10万参数下对远端演练执行 server-side SLO + `roomStatePatch` 最低出现 1 次的软验收；如需不做 patch 硬约束，可把对应阈值设为 0。
`DEPLOY_REHEARSAL_ROOM_STATE_PATCH_MIN_*` 为通用覆盖参数，优先级高于单房间默认值；也可用 `DEPLOY_REHEARSAL_100K_SINGLE_ROOM_ROOM_STATE_PATCH_MIN_*` 指定 lane-only 默认值。

二价模式会在演练收尾自动尝试生成核验报告（若提供证据 token）。
报告路径：`${DEPLOY_REHEARSAL_OUT_DIR}/verify-second-price-payment-summary.tsv`。若脚本 token 与环境不一致，可显式覆盖：
```sh
DEPLOY_REHEARSAL_SECOND_PRICE_VERIFY=1 \
DEPLOY_REHEARSAL_SECOND_PRICE_TOKEN="$TOKEN" \
DEPLOY_REHEARSAL_SECOND_PRICE_TOKEN_FILE="$TOKEN_FILE" \
make deploy-perf-rehearsal-second-price
```

   Copy-paste operator form (recommended):

   ```sh
   BASE_URL="https://auction.example.com" \
   BASE_WS_URL="wss://ws.auction.example.com" \
   DEPLOY_REHEARSAL_OUT_DIR=".deploy-rehearsal-100k-$(date -u +%Y%m%dT%H%M%SZ)" \
   DEPLOY_REHEARSAL_100K_TARGET=100000 \
   DEPLOY_REHEARSAL_100K_AID=auc_demo \
   DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1 \
   DEPLOY_REHEARSAL_100K_REQUIRE_WS_SCHEMA_CHECK=1 \
   DEPLOY_REHEARSAL_100K_SINGLE_ROOM_AID=auc_single_room_vickrey \
   DEPLOY_REHEARSAL_ROOM_STATE_PATCH_MIN_EMITTED=1 \
   DEPLOY_REHEARSAL_ROOM_STATE_PATCH_MIN_BIDS=1 \
   DEPLOY_REHEARSAL_100K_WS_SCHEMA="${SCHEMA_VERSION:-1}" \
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
that are already configured with second-price rules (`rules.mode: VICKREY`,
legacy aliases such as `second`, `vickrey`, `auction2`, `2`, `second_price`);
`deploy-perf-rehearsal-100k` is a remote performance/operator wrapper and does
not inject bid mode itself.

   For single-room 100k local rehearsal with second-price mode (for evidence prep
   before/alongside remote runs), use:

   ```sh
   LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-single-room-$(date +%Y%m%d) --auction-mode VICKREY --shards 1" \
     make load-100k-rehearse
   ```

   or the shorter alias:

   ```sh
   make load-100k-single-room-second-price-rehearse
   make load-100k-single-room-vickrey-rehearse
   ```

   If you want local 100k single-room evidence + hard gate in one command, run:

   ```sh
   LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --label superstretch-single-room-gate-$(date +%Y%m%d) --auction-mode VICKREY --shards 1" \
     make load-100k-single-room-rehearsal-gate
   make load-100k-single-room-second-price-gate
   make load-100k-single-room-vickrey-gate
   ```

   For local `load-100k` packs (`...-rehearse` / `...-rehearsal-gate`), evidence stays in
   `.load-100k-rehearsals/<label>`; for deploy-perf wrappers it is in
   `DEPLOY_REHEARSAL_OUT_DIR` / `PERF_GATE_OUT_DIR`.
   Keep the relevant paths in the issue/meeting note so evidence is recoverable later.

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
   CLIENT_CONNECT_FAIL_RATE_MAX_PCT="${CLIENT_CONNECT_FAIL_RATE_MAX_PCT:-${DEPLOY_REHEARSAL_CONNECT_FAIL_RATE_MAX_PCT:-}}" \
   MAX_TIMER_ERR_INTERNAL="${DEPLOY_REHEARSAL_MAX_TIMER_ERR_INTERNAL:-}" \
   MAX_TIMER_ERR_INTERNAL_KEY_TYPE="${DEPLOY_REHEARSAL_MAX_TIMER_ERR_INTERNAL_KEY_TYPE:-}" \
   MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH="${DEPLOY_REHEARSAL_MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH:-}" \
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
   checks were not required. For remote proof runs that also track client
   connect outcome, set `CLIENT_CONNECT_FAIL_RATE_MAX_PCT` (for example
   `0.1` for 0.1%). Optionally set `MAX_TIMER_ERR_INTERNAL`,
   `MAX_TIMER_ERR_INTERNAL_KEY_TYPE`, and
   `MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH` to gate timer corruption errors at
   the same pass/fail boundary (set any to `0` for no regressions).

   In operator runs with evidence-only mode (`DEPLOY_REHEARSAL_REPORT_ONLY=1` for
   500/50 or `DEPLOY_REHEARSAL_100K_REPORT_ONLY=1` for super-stretch),
   this command is expected to produce `result: FAIL-REPORTED` when required
   thresholds fail but still should continue with manual triage.

6. Archive the evidence pack.

   Keep these artifacts together:

   - preflight `manifest.txt`
   - preflight `status.tsv`
   - preflight route artifacts
   - (for super-stretch local pack path, keep `preflight/status.tsv` in
     `pack_root/preflight`)
   - server metrics JSON used by the perf gate
   - local `load-100k-rehearsal` pack 可选项：`preflight/status.tsv`（保存本地门禁检查快照）
   - remote perf gate `summary.md`
   - remote perf gate `gate.tsv`
   - 若演练为二价（Vickrey / second_price）且有 token：`verify-second-price-payment-summary.tsv`
   - optional `client-summary.json`
   - optional `client-observed.tsv`
   - optional SRS smoke evidence
   - `summary.tsv` / `manifest.json`（`summary.tsv` 推荐含 `run_dir`、`log_file`、`metrics_file` 便于后续回放路径追踪）

6.1 Run replay/catchup consistency checks when accessible.

   If verifier can connect to the same auction data source, run:

   ```sh
   VERIFY_AID=<auction-id> make verify
   VERIFY_AID=<auction-id> make verify-evidence
   ```

   If verifier is unavailable at the rehearsal node, require the load evidence
   fields instead:

   - `catchup` section in `summary.tsv` when `--catchup-smoke` is enabled.
   - `catchup_checks` in `manifest.json` and `runs/<run>/catchup.log` for
     super-stretch rehearsal packs（对应 `summary.tsv` 的 `run_dir/catchup_log`）。
   - `ws_precheck` section in `manifest.json` and
     `runs/<run>/ws-schema-precheck.log` when `--ws-precheck` is enabled（对应
     `summary.tsv` 的 `run_dir/ws_precheck_log`）。
   - 复盘远程压测建议以 `summary.tsv` 为索引字段：从某行读取 `run_dir` 后直接打开该行的
     `log_file`、`metrics_file`、`catchup_log`、`ws_precheck_log`，避免按 `run` id 人工拼路径。

   为避免人工逐行核对，可直接用一条脚本或 Make 目标做打点复核：

   ```sh
   scripts/eval-load-100k-rehearsal.sh \
     --pack-dir .load-100k-rehearsals/<label> \
     --report .load-100k-rehearsals/<label>/eval-load-100k-rehearsal-summary.tsv

   # 或
   LOAD_100K_REHEARSAL_EVAL_LABEL="<label>" \
   make load-100k-eval
   ```

   上述 `--report`（或 `LOAD_100K_REHEARSAL_EVAL_REPORT`）会将同样结果固定写入
   `eval-load-100k-rehearsal-summary.tsv`，便于审阅时直接附证据。

  `make load-100k-eval` 默认也会写入同名文件到目标演练目录，所以只要命令成功就会留下可签名的评估汇总文件。
   若演练为二价（Vickrey / second_price），建议再产出
   `scripts/verify-second-price-payment.sh --pack-dir .load-100k-rehearsals/<label>` 的
   `verify-second-price-payment-summary.tsv`，并与上述 `eval-load-100k-rehearsal-summary.tsv` 一并归档。
   当 `catchup_checks.enabled=true` 或 `ws_precheck_checks.enabled=true` 时，
   对应 `catchup_status` / `ws_precheck_status` 会进入硬性 PASS 约束。

6.2 一键闭环汇总（可选）

   演练完成后，如果你只想要一份可复用结论，可运行：

   ```sh
   DEPLOY_REHEARSAL_CHECK_OUT_DIR="/path/to/.deploy-rehearsal-<timestamp>" \
   scripts/deploy-rehearsal-closure-check.sh --out-dir "$DEPLOY_REHEARSAL_CHECK_OUT_DIR"
   ```

   或通过 Make：

   ```sh
   DEPLOY_REHEARSAL_CHECK_OUT_DIR="/path/to/.deploy-rehearsal-<timestamp>" \
   DEPLOY_REHEARSAL_CHECK_REPORT=".deploy-rehearsal-<timestamp>/closure-summary.tsv" \
   make deploy-rehearsal-check
   # 可选：显式绑定二价结算核对报告路径
   DEPLOY_REHEARSAL_CHECK_SECOND_PRICE_REPORT=".deploy-rehearsal-<timestamp>/verify-second-price-payment-summary.tsv" \
   make deploy-rehearsal-check

   # 或直接出可贴 issue 的 Markdown 版：
   DEPLOY_REHEARSAL_CHECK_OUT_DIR="/path/to/.deploy-rehearsal-<timestamp>" \
   make deploy-rehearsal-check-md
   ```

   建议将输出行持久化（示例字段）：`artifact\tstatus\treason\tpath`（TSV）或 Markdown 表格（`make deploy-rehearsal-check-md`），并至少落这几个硬性字段：

   - `deploy_preflight`（必须 `PASS`）
   - `remote_perf_gate`（`PASS` 或 `PASS-REPORTED`）
   - `remote_perf_client_observed`（有客户端观测路径时为 `PASS`，否则 `SKIP`）
   - `load_eval`（存在时必须 `PASS`）
   - `second_price_payment`（二价场景建议 `PASS`）
   - `catchup_checks`（如 `manifest.json` 启用时必须 `PASS`）
   - `ws_precheck`（如 `manifest.json` 启用时必须 `PASS`）
   - `overall`（最终结论）

7. 清理本地 load 遗留拍品（建议在演练结尾、销毁资源前）

   演练后建议先清理 `auc_load_*` 的遗留状态，避免旧状态污染下一次压测。

   ```sh
   # 先 dry-run，确认扫描到的对象
   LOAD_CLEANUP_SCAN_AUCTIONS=1 LOAD_CLEANUP_DRY_RUN=1 make cleanup-load-auctions

   # 按前缀扫描（适合大规模压测，避免全量扫描）
   LOAD_CLEANUP_AUCTION_PREFIX="auc_load_" LOAD_CLEANUP_DRY_RUN=1 make cleanup-load-auctions

   # 按 ids 清理
   LOAD_CLEANUP_AUCTION_IDS="auc_load_1,auc_load_2" make cleanup-load-auctions

   # 从文件读取 id 并清理
   LOAD_CLEANUP_AUCTION_FILE="/path/to/auction-ids.txt" make cleanup-load-auctions
   ```

   `LOAD_CLEANUP_SCAN_AUCTIONS` 与 `LOAD_CLEANUP_DRY_RUN` 支持
   `1|true|yes|on`（启用）和 `0|false|no|off`（禁用）。

   `LOAD_CLEANUP_AUCTION_PREFIX` 可用于缩小扫描范围（例如 `auc_load_`），当设置时会自动走扫描路径。

8. Run teardown.

   Follow the #154 teardown/cost checklist after the evidence has been copied to
   its durable location. Record which remote resources were stopped or deleted.

## Go/no-go table

| Gate | Go condition | No-go condition |
| --- | --- | --- |
| Deploy preflight | Public routes return expected 2xx responses and artifacts are captured | Any required route is unreachable unless `ALLOW_FAILURE=1`/`true`/`yes`/`on` is intentionally documented |
| HTTPS boundary | `DEPLOY_REHEARSAL_REQUIRE_HTTPS=1` (or `DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1` for super-stretch) and `BASE_URL` starts with `https://` | `require_https` row fails when HTTPS is enforced but HTTP URL is passed |
| WebSocket reachability | `/ws` returns `401/403`, or `101` when token is allowed/provided; strict upgrade-only requires `WS_PRECHECK_TOKEN`+`REQUIRE_WS_UPGRADE=1`/`true`/`yes`/`on` | `/ws` returns unexpected HTTP status, or `101` is broken when upgrade-mode check is enabled |
| WebSocket schema guard | `ws_schema` precheck passes when `REQUIRE_WS_SCHEMA_CHECK=true`, or row is intentionally skipped when check is off | Schema mismatch, timeout, or websocket handshake error |
| Reconnect/replay consistency | Catchup checks are present and pass, or verifier (`make verify` / `make verify-evidence`) is explicitly executed and green | Catchup checks are missing for runs that claim disconnection/lag recovery behavior |
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
