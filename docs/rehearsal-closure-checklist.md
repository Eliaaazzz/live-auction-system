# Rehearsal closure checklist (execution template)

用于 #112/#87 的复盘签名，替换“口头约定”。建议每次远端或本地复盘都提交本模板一版。

- [ ] Owner:
- [ ] Deadline:
- [ ] 并发规模（例如：500/50、100k、2k×4 shards）:
- [ ] 结算模式（canonical: first_price / second_price）:
- [ ] 兼容写法（如 ENGLISH / VICKREY / second）:
- [ ] 目标链接 / 资源标识:
- [ ] Evidence 目录（可复现绝对路径）:
- [ ] 关联提交（git commit / tag）:
- [ ] 复盘时间戳（UTC）:

## 0) 基础前置

- [ ] `deploy-preflight`（`scripts/deploy-preflight.sh`）完成：
  - manifest.txt
  - status.tsv
  - route/metrics 证据
  - `failed_checks=0`（或在备注里写明豁免/跳过）
- [ ] `https` + `wss` 边界明确：`REQUIRE_HTTPS=1` + 证据中的 base url。
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
- [ ] 若二价/赢者付次高价模式，附上支付价核对证据（winner pay = runner-up）
  - 典型产物：`verify-second-price-payment-summary.tsv`（脚本 `scripts/verify-second-price-payment.sh`）
- [ ] `remote_perf_gate` 结论：
  - 严格：`result=PASS`
  - Evidence-only：`result=PASS-REPORTED` 并在备注写明
- [ ] 客户端可观测指标（可选）存在并可追溯（`client-summary.json`/`client-observed.tsv`）

## 3) 重放/断连闭环

- [ ] 可连 verifier 时执行：
  - `VERIFY_AID=<aid> make verify`
  - `VERIFY_AID=<aid> make verify-evidence`
- [ ] verifier 不可达时，给出 `catchup_checks` 或 `ws_precheck_checks` 的 `PASS/原因`

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
