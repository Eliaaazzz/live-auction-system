---
name: Rehearsal closure report
about: 标准化 #112/#87 演练复盘闭环，避免口头约定
labels: "documentation,priority:p2"
---

## Rehearsal closure report

用于 #112/#87 或其他高并发演练复盘。请在每次演练结束后用此清单补齐：

- Owner:
- Owner deadline:
- Rehearsal target concurrency:
- Rehearsal mode:
  - canonical: `rules.mode=ENGLISH` or `rules.mode=VICKREY`
  - legacy aliases (optional): `first`, `second`, `auction1`, `auction2`, `1`, `2`, `first_price`, `second_price`
- Evidence directory:
- Target URL / deployment tag:
- Commit / tag:
- Rehearsal timestamp (UTC):
- `HTTPS/WSS` check: PASS / FAIL / SKIP (if local-only)

Evidence path contract:
- 远端演练（deploy/perf）：`Evidence directory` 填 `DEPLOY_REHEARSAL_OUT_DIR`
  (`.deploy-rehearsal-<timestamp>`)
- 本地 10 万演练（load-100k）：`Evidence directory` 填
  `.load-100k-rehearsals/<label>`（其中 `<label>` 来源于 `LOAD_100K_REHEARSAL_ARGS`）

- [ ] 1) preflight
  - [ ] `manifest.txt` + `status.tsv` 落盘
  - [ ] `/healthz` `/metrics` `/admin.html` `/room.html` `/ws` 路由证据存在
  - [ ] `deploy-preflight` 结论附上（或说明为何不能复现）
  - [ ] `HTTPS/WSS`：
    - [ ] 远端目标：`REQUIRE_HTTPS=1` 与 `DEPLOY_REHEARSAL_REQUIRE_HTTPS=1` 都已满足
    - [ ] 本地回放：写明 `SKIP` + 原因

- [ ] 2) load/rehearsal pack
  - [ ] `summary.tsv` + `manifest.json` 落盘
  - [ ] `runs/*/load.log` + `runs/*/metrics.txt` 落盘
  - [ ] `health-start.json` / `health-end.json` 落盘
  - [ ] 运行参数快照已记录（例如 `LOAD_100K_REHEARSAL_ARGS` / `LOAD_100K_REHEARSAL_LABEL`）
  - [ ] 若开启了 `--catchup-smoke`，有 `runs/*/catchup.log`
  - [ ] 若开启了 `--ws-precheck`，有 `runs/*/ws-schema-precheck.log`

- [ ] 3) 闭环门禁
  - [ ] `make load-100k-eval` 结论（`PASS` / `PASS-REPORTED`）
  - [ ] `remote_perf_gate` 结论（`PASS` / `PASS-REPORTED`）
  - [ ] 若使用 `MAX_TIMER_ERR_INTERNAL*` 作为性能硬闸：
    - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL`：`（填写数值或 N/A）`
    - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_KEY_TYPE`：`（填写数值或 N/A）`
    - `LOAD_100K_REHEARSAL_MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH`：`（填写数值或 N/A）`
    - 在 `remote_perf_gate` 结果中补充对应实际计数（来自 `server_timer_err_internal*`）
  - [ ] 若二价/赢者付次高价模式，附上支付价核对（winner pays second highest）证据路径
    - 建议附带 `verify-second-price-payment-summary.tsv`，或记录 `load-100k-eval` 的 `LOAD_100K_REHEARSAL_SECOND_PRICE_REPORT`。
  - [ ] 客户端观测路径（`client-summary.json` / `client-observed.tsv`）有无明确记录（如有则区分 server-side 与 client-side 指标边界）
  - [ ] `catchup_checks` 与 `ws_precheck` 结论或不可达原因说明
  - [ ] 若不跑 `deploy-perf-rehearsal`，说明本次是否只做本地演练（例如 `make demo` / `make load-100k-rehearse`）

- [ ] 4) 一致性
  - [ ] `VERIFY_AID=<aid> make verify`（或写明原因）
  - [ ] `VERIFY_AID=<aid> make verify-evidence`（或写明原因）
  - [ ] 若 verify 不可达，则至少补齐 `catchup_checks` 或 `ws_precheck` PASS；否则拒绝 PASS 结论
  - [ ] `smoke:catchup` 一致性复核（推荐）：
    ```sh
    cd apps/web
    WEB_SMOKE_AID="<AID>" \
    HOST_HTTP="$BASE_URL" \
    HOST_WS="${BASE_WS_URL:-wss://ws.example.com}" \
    npm run -s smoke:catchup
    ```
    期望输出包含：`TC-T6-102 catchup smoke PASSED`，并出现 `ROOM_SNAPSHOT` 与 `BID_ACCEPTED`（`BID_ACCEPTED.seq > ROOM_SNAPSHOT.seq`）。
    若失败，标注失败原因并暂停“overall PASS”。

- [ ] 5) 结论
  - [ ] overall gate: PASS / PASS-REPORTED / FAIL
  - [ ] 与 #87/#112 目标的偏差与后续动作已列出

## 常用命令（选）

- `make deploy-rehearsal-check`
- `make deploy-rehearsal-check-md`（直接生成可贴到 issue comment 的 Markdown 表格）
- `make load-100k-eval`
- `make load-100k-rehearsal-gate` / `make load-100k-rehearsal-gate-second-price`（可选）
- `make load-100k-single-room-rehearsal-gate` / `make load-100k-single-room-second-price-gate` / `make load-100k-single-room-vickrey-gate`（可选）
- `make verify && make verify-evidence`
- `scripts/deploy-rehearsal-closure-check.sh --out-dir "$$out_dir" --require-second-price-report auto`（二价模式建议保留）
- 本地复核阈值回放（建议放在问题复测前）：
  ```sh
  SERVER_METRICS=/tmp/metrics.json
  CLIENT_SUMMARY=/tmp/client.json
  # Optional local replay of timer-error ceilings (set to 0 for strict zero-regression)
  MAX_TIMER_ERR_INTERNAL=${MAX_TIMER_ERR_INTERNAL:-0}
  MAX_TIMER_ERR_INTERNAL_KEY_TYPE=${MAX_TIMER_ERR_INTERNAL_KEY_TYPE:-0}
  MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH=${MAX_TIMER_ERR_INTERNAL_SEQ_MISMATCH:-0}
  scripts/remote-perf-gate.sh \
    --server-metrics "$SERVER_METRICS" \
  --target "${TARGET_CONNS:-500}" \
    --client-summary "$CLIENT_SUMMARY" \
    --out-dir "$OUT_DIR"
  ```
