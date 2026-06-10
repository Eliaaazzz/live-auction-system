# Rehearsal closure checklist (execution template)

用于 #112/#87 的复盘签名，替换“口头约定”。建议每次远端或本地复盘都提交本模板一版。

- [ ] Owner:
- [ ] Deadline:
- [ ] 并发规模（例如：500/50、100k、2k×4 shards）:
- [ ] 结算模式（canonical: `rules.mode=ENGLISH` 或 `rules.mode=VICKREY`）:
- [ ] 兼容写法（如 `first`, `second`, `auction1`, `auction2`, `1`, `2`, `first_price`, `second_price`）:
- [ ] 目标链接 / 资源标识:
- [ ] Evidence 目录（可复现绝对路径）:
- [ ] `HTTPS/WSS`：PASS / FAIL / SKIP（本地演练）
- [ ] 关联提交（git commit / tag）:
- [ ] 复盘时间戳（UTC）:
- [ ] 单房间二价门禁场景（固定 `--shards 1 --auction-mode VICKREY`）：PASS / FAIL / SKIP:
- [ ] 单房间门禁目标命令：`make load-100k-single-room-rehearsal-gate`:
- [ ] `load-100k-single-room-rehearsal-gate` 证据目录：`.load-100k-rehearsals/<label>/`:

## 证据目录口径（统一）

- 远端演练（`make deploy-perf-rehearsal*`）：
  - 以 `DEPLOY_REHEARSAL_OUT_DIR` 为根，默认 `.deploy-rehearsal-<timestamp>`
  - 预检：`manifest.txt` + `status.tsv`
  - 压测门禁：`perf-gate/summary.md` + `perf-gate/gate.tsv`
  - 二价核验（如适用）：`verify-second-price-payment-summary.tsv`
- 本地 10万复盘（`make load-100k-*`）：
  - 以 `LOAD_100K_REHEARSAL_PACK_DIR` 为根，默认 `.load-100k-rehearsals`
  - 运行包：`.load-100k-rehearsals/<label>/manifest.json` + `.load-100k-rehearsals/<label>/summary.tsv`
  - 本地预检：`<pack>/preflight/status.tsv`（由 `make load-100k-preflight` 产出）
  - 门禁汇总（可选）：`eval-load-100k-rehearsal-summary.tsv`（`make load-100k-eval` / `load-100k-rehearsal-gate` 产出）
  - 二价核验（如适用）：`<pack>/verify-second-price-payment-summary.tsv`

## 0) 基础前置

- [ ] `deploy-preflight`（`scripts/deploy-preflight.sh`）完成：
  - manifest.txt
  - status.tsv
  - route/metrics 证据
  - `failed_checks=0`（或在备注里写明豁免/跳过）
  - 若设置 `EXPECTED_BUILD_REVISION`，需通过 `version_revision_check`
  - 若设置 `EXPECTED_WS_SCHEMA`，需通过 `ws schema check`
- [ ] `https` + `wss` 边界明确：`REQUIRE_HTTPS=1` + `DEPLOY_REHEARSAL_REQUIRE_HTTPS=1` + 证据中的 base url（若为本地演练则写明 `SKIP`）。
- [ ] WS schema 约束明确：`REQUIRE_WS_SCHEMA_CHECK=true` 时通过；如关闭则在结论说明。

## 1) 演练产物

- [ ] `summary.tsv`
- [ ] `manifest.json`
- [ ] `runs/<run>/load.log`
- [ ] `runs/<run>/metrics.txt`
- [ ] `health-start.json`
- [ ] `health-end.json`
- [ ] `runs/<run>/catchup.log`（若启用 `--catchup-smoke`）
- [ ] `runs/<run>/ws-schema-precheck.log`（若启用 `--ws-precheck`）

## 2) 一致性与性能门禁

- [ ] `make load-100k-eval` 结论：
  - `result=PASS`（或 `PASS-REPORTED` + 原因）
  - 关键字段：`observer* / seq_gap / backpressure` 在阈值内
- [ ] 运行参数快照已记录（`LOAD_100K_REHEARSAL_ARGS` / `LOAD_100K_REHEARSAL_LABEL`）
- [ ] （可选）若使用 timer 异常硬闸，已记录：
  - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL`
  - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_KEY_TYPE`
  - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH`
- [ ] 若二价/赢者付次高价模式，附上支付价核对证据（winner pay = runner-up）
  - 典型产物：`verify-second-price-payment-summary.tsv`（脚本 `scripts/verify-second-price-payment.sh`）
- [ ] 单房间二价门禁执行条目（如适用）：
  - 命令：`load-100k-single-room-rehearsal-gate`
  - 强制参数：`--shards 1 --auction-mode VICKREY`
  - 结论：`result=PASS`（或 `PASS-REPORTED` + 原因）
  - 关键字段：`seq_gap=0` 且 winner_pay = runner_up_pay
- [ ] `remote_perf_gate` 结论：
  - 严格：`result=PASS`
  - Evidence-only：`result=PASS-REPORTED` 并在备注写明
  - 若启用 timer 硬闸，补充 `MAX_TIMER_ERR_INTERNAL*` 阈值与实际观察值（来自 `gate.tsv`）
  - 可复测（本地）：
    ```sh
    SERVER_METRICS=/tmp/metrics.json
    OUT_DIR=/tmp/lumen-gate-out
    mkdir -p "$OUT_DIR"

    MAX_TIMER_ERR_INTERNAL=0 \
    MAX_TIMER_ERR_INTERNAL_KEY_TYPE=0 \
    MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH=0 \
    ./scripts/remote-perf-gate.sh \
      --server-metrics "$SERVER_METRICS" \
      --target 500 \
      --out-dir "$OUT_DIR"
    ```
    - 期望：`result=PASS` 且 `server_timer_err_internal*` 全部 `PASS`
    - 期望失败复测（sanity）：把 `timerErrInternal*` 设为正整数并保持阈值为 0，应出现 `result=FAIL` 与 `threshold_breach`
- [ ] 客户端可观测指标（可选）存在并可追溯（`client-summary.json`/`client-observed.tsv`）

## 3) 重放/断连闭环

- [ ] 可连 verifier 时执行：
  - `VERIFY_AID=<aid> make verify`
  - `VERIFY_AID=<aid> make verify-evidence`
- [ ] verifier 不可达时，给出 `catchup_checks` 或 `ws_precheck_checks` 的 `PASS/原因`

## 3.1) Live BID 复验（`ROOM_JOIN -> BID_PLACE -> BID_ACCEPTED`）

- [ ] 远端演练完成后执行 `smoke:catchup`：
  ```sh
  cd apps/web
  WEB_SMOKE_AID="<演练拍卖ID>" \
  HOST_HTTP="$BASE_URL" \
  HOST_WS="<wss://ws-host>" \
  npm run -s smoke:catchup | tee "$OUT_DIR/live-bid-smoke.log"
  ```
  - `HOST_WS` 是 WebSocket 基础地址，**不要**加 `/ws` 路径，脚本会自动拼接。
  - 若使用和 HTTP 同域，常见写法为 `https://` -> `wss://`，`http://` -> `ws://`。
  - 期望日志含：
    - `TC-T6-102 catchup smoke PASSED`
    - 先看到 `ROOM_SNAPSHOT`，再看到 `BID_ACCEPTED`
    - `BID_ACCEPTED` 的 `seq > ROOM_SNAPSHOT.seq`
- [ ] 若脚本返回码非 0（或日志未出现上述闭环），标记为 `FAIL` 并暂停该演练闭环：不允许写“远端 bidding 已闭环”。

## 4) 一句结论（用于 issue/PR 评论）

```text
- Owner: ...
- Deadline: ...
- Concurrency target: ...
- Evidence dir: ...
- Deployed target: ...
- Commit: ...
- Timestamp: ...
- Gate results:
  - deploy_preflight:
  - version_revision_check:
  - remote_perf_gate:
  - remote_perf_client_observed:
  - load_eval:
  - second_price_payment:
  - catchup_checks:
  - ws_precheck:
  - overall:
- Notes:
```

若任何红项为 `FAIL`，不通过本次复盘，不得在对外沟通中写“已完成企业级并发验证”。

复盘摘要可直接用新目标生成：

- `make deploy-rehearsal-check-md`（在 `DEPLOY_REHEARSAL_CHECK_OUT_DIR` 指定证据目录后运行）
