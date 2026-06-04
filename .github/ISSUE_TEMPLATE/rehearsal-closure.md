---
name: Rehearsal closure report
about: 标准化 #112/#87 演练复盘闭环，避免口头约定
labels: "type:rehearsal,priority:p2"
---

## Rehearsal closure report

用于 #112/#87 或其他高并发演练复盘。请在每次演练结束后用此清单补齐：

- Owner:
- Owner deadline:
- Rehearsal target concurrency:
- Rehearsal mode (canonical: first_price / second_price):
- Legacy aliases used during this run (optional, e.g. ENGLISH / VICKREY / second / second-price):
- Evidence directory:
- Target URL / deployment tag:
- Commit / tag:
- Rehearsal timestamp (UTC):

- [ ] 1) preflight
  - [ ] `manifest.txt` + `status.tsv` 落盘
  - [ ] `/healthz` `/metrics` `/admin.html` `/room.html` `/ws` 路由证据存在
  - [ ] HTTPS/WSS 条件声明已覆盖（若失败/跳过已写明原因）
  - [ ] `deploy-preflight` 结论附上

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
  - [ ] 若二价/赢者付次高价模式，附上支付价核对（winner pays second highest）证据路径
    - 建议附带 `verify-second-price-payment-summary.tsv`，或记录 `load-100k-eval` 的 `LOAD_100K_REHEARSAL_SECOND_PRICE_REPORT`。
  - [ ] 客户端观测路径（`client-summary.json` / `client-observed.tsv`）有无明确记录
  - [ ] `catchup_checks` 与 `ws_precheck` 结论或不可达原因说明

- [ ] 4) 一致性
  - [ ] `VERIFY_AID=<aid> make verify`（或写明原因）
  - [ ] `VERIFY_AID=<aid> make verify-evidence`（或写明原因）

- [ ] 5) 结论
  - [ ] overall gate: PASS / PASS-REPORTED / FAIL
  - [ ] 与 #87/#112 目标的偏差与后续动作已列出

## 常用命令（选）

- `make deploy-rehearsal-check`
- `make deploy-rehearsal-check-md`（直接生成可贴到 issue comment 的 Markdown 表格）
- `make load-100k-eval`
- `make load-100k-rehearsal-gate` / `make load-100k-rehearsal-gate-second-price`（可选）
- `make verify && make verify-evidence`
