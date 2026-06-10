# Demo Runbook · 演示手册 (T10)

> **3-minute full-chain demo** for the ByteDance Douyin E-commerce AI Full-Stack
> challenge. The governing rule (V9 §4.4): **every demo node has a corresponding
> `make` verification command** — the demo is an *assertable path*, not a screen
> recording. The single source of truth for the path is `make demo`
> (`Makefile`); this doc is the human script + fallback plan wrapped around it.
>
> - Internal freeze: **2026-06-08** · Rehearsal (incl. fallback): **2026-06-09** · D-day: **2026-06-10**
> - Owners: **@PDGGK** (public deploy · narration · backup recording · product/demo lens) · **@fariZzzz** (`make demo` orchestration · verifier/load/chaos evidence · this runbook)

---

## 0. One command · 一条命令

```bash
make demo      # full §12 path, leaves the stack up so you can show the UI
make down      # tear down when finished
```

`make demo` runs every §12 node in order and is green **iff** the whole path
holds — each sub-target exits non-zero on any failed assertion and `make` aborts
on the first failure, so a partial path can never report success. That green run
is the T10 exit evidence ("3-min demo path = e2e suite green").

For a fast wiring check (small N, no 500/50 wall-clock): `make demo-smoke`.

---

## 1. The path · 演示动线 (V9 §12)

Each row: the on-screen moment, the **narration** (说什么), the **`make` command
that proves it**, and the assertable signal to point at.

| # | 节点 On-screen | 说 Narration (zh) | `make` 验证 | Assert / 可指 |
|---|---|---|---|---|
| 1 | 卖家上传商品图，VLM 抽取事实 | "AI 抽取品牌/成色/瑕疵，高风险字段标注『卖家声明·AI 未验证』" | `make e2e-dummy-bid` (step: facts draft + factsConfirmed gate) | `highRiskFieldsDisclaimer` present; create-auction **forbidden** until confirmed |
| 2 | 卖家 confirm/edit facts + 配规则 | "起拍价 / 加价步长 / 时长 / 反狙击窗口，卖家最终背书" | same e2e (freeze → `CodeOKFrozen`) | freeze returns `OK_FROZEN`; rules locked |
| 3 | 开拍，多观众实时出价，AI 冒泡 | "开拍/跳涨/冷场30s/落锤四触发，AI 是旁路、非裁决" | same e2e (start → `OK_LIVE` → multi-WS bid → broadcast) | bidder **and** observer both get `BID_ACCEPTED` |
| 3.5 | 结算模式（可选） | "可切二价模式：赢者支付第二高价（Vickrey）" | `admin` 端新建拍品规则栏 `rules.mode`（`ENGLISH` / `VICKREY`；兼容别名 `first` / `second` / `auction1` / `auction2` / `1` / `2` / `first_price` / `second_price`） | 秒表现场强调：终态成交价由 `rules.mode` / 兼容别名的策略决定 |
| 4 | 末 N 秒反狙击，倒计时延长 | "最后时刻出价自动延时，反阻击" | `make web-smoke-antisnipe` **or** UI (live) + `AUCTION_EXTENDED` event | `extendCount` badge increments — 反狙击窗口生效 |
| 5 | 落锤 → 证据卡 | "成交即生成证据卡：图/价/timeline + `events_hash`" | `make verify-evidence` | exit 0; no `hash_break` — chain recomputes clean |
| 6 | Replay Verifier consistent | "Stream / Redis / MySQL 三方一致 + hash 链校验" | `make verify` | `consistent`; no `mismatch_at_seq` / `hash_break_at_seq` |
| 7 | 监控面板 500/50 | "500 在线 + 50 活跃出价，ack/broadcast p95 达标，**seq gap = 0**" | `make load` | p95 within §4.2 budgets; `seqGapCount=0`; post-load verify consistent |
| 7.5 | 规模演练（非 P0，可选） | "企业级并发边界盘查：10万级压测用于瓶颈归档，不作为演示硬闸" | `make load-100k-rehearse` 的 `LOAD_100K_REHEARSAL_ARGS` 可传 `--base-ws-url`（如网关走独立 WS 域名时，不要加 `/ws`），例如：`LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --catchup-smoke --label superstretch-$(date +%Y%m%d) --base-ws-url wss://ws.example.com" make load-100k-rehearse`（演练机）<br/>单房间极值压测可用 `LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --auction-mode VICKREY --shards 1 --label superstretch-single-room-$(date +%Y%m%d)" make load-100k-single-room-rehearsal-gate`（别名同 `make load-100k-single-room-second-price-gate`） | `seqGapCount`、回放一致性与断线重连回放 (`catchup`) 与 schema 前置检查（可加 `--ws-precheck`）重点；请保留 `manifest.json` / `summary.tsv` / `runs/<run>/catchup.log` / `runs/<run>/ws-schema-precheck.log` 作为容量边界证据 |
| 7.6 | 远端演练边界 | 按 [deploy rehearsal 卡片](deploy-rehearsal-card.md) 执行，或直接用 `make deploy-perf-rehearsal BASE_URL=<https://domain> BASE_WS_URL=<wss://ws.domain> DEPLOY_REHEARSAL_REQUIRE_HTTPS=1 [DEPLOY_REHEARSAL_AID=<auction>] [PERF_GATE_CLIENT_SUMMARY=<k6_summary.json>]`（证据-only时加 `DEPLOY_REHEARSAL_REPORT_ONLY=1`）；如为 10万级复盘可用 `make deploy-perf-rehearsal-100k BASE_WS_URL=<wss://ws.domain> DEPLOY_REHEARSAL_100K_REQUIRE_HTTPS=1 [DEPLOY_REHEARSAL_100K_REPORT_ONLY=1]`；二价 lane 用 `make deploy-perf-rehearsal-second-price ...` 或 `make deploy-perf-rehearsal-100k-second-price ...`，提前把演练房间配置为 `rules.mode: VICKREY`（兼容别名同模板） |  | 服务器端 SLO 与 client-observed 证据边界分离，避免把 WAN 延迟误判为后端瓶颈 |
| 7.7 | 远端单房间边界（10万） | 使用 `make deploy-perf-rehearsal-100k-single-room-second-price BASE_URL=<https://domain> BASE_WS_URL=<wss://ws.domain>`（先配置好二价模式）或 `make deploy-perf-rehearsal-100k-single-room` 验证远端单房间 10万并发；本地参数链路可用 `LOAD_100K_REHEARSAL_ARGS="--confirm --attempts 1 --json --auction-mode VICKREY --shards 1" make load-100k-single-room-rehearsal-gate`（或 `...-second-price-gate`） |  | `roomStatePatchEmitted` / `roomStatePatchBids` 可用于 coalesced 载荷约束 |
| 8 | 故障演练 30s ×5 | "MySQL/WS/Timer/AI/Redis 各挂一段，证明降级 + 自愈" | `make chaos` | 5× `CHAOS_OK` + `✓ T9 PASSED · 5/5`; AI 挂时出价继续 (V9 P3) |

> `make demo` runs nodes 1–3 (`e2e-dummy-bid`), 5 (`verify-evidence`), 6 (`verify`),
> 7 (`load`), 8 (`chaos`) automatically. Node 4 (anti-snipe) is shown live in the
> UI / backup clip — see §3.

---

## 2. Three-minute script · 三分钟脚本

Pre-flight (before the clock): `make up && make seed` so the stack is warm.
If you're rehearsing frontend wire smoke specifically, you can use `make web-smoke-prepare` for
the same up+seed bootstrap.
If you want to validate the multi-tab visibility path (TC-T6-113), use
`make web-smoke-multitab-prepare`.
Open two tabs: `admin.html` (seller) and `room.html?auction=auc_demo` (buyer).

| 时间 | 画面 | 旁白要点 |
|---|---|---|
| 0:00–0:30 | admin: 上传图 → VLM facts → confirm → 配规则 → 开拍 | 节点 1–2：AI 抽取 + 卖家背书 + 规则冻结 |
| 0:30–1:15 | room: 多端出价，价格 odometer + 排行榜飞行 + AI 气泡 | 节点 3：实时竞价氛围；强调 AI 旁路 |
| 1:15–1:35 | room: 末段反狙击，倒计时 `+Ns`，`extendCount` 徽标 | 节点 4：反阻击是差异化亮点 |
| 1:35–2:00 | 落锤 → 证据卡，展开 hash 链；切终端 `make verify-evidence` / `make verify` | 节点 5–6：可信成交 + 三方一致 |
| 2:00–2:35 | Grafana 面板：500/50，p95，seq gap=0；终端 `make load` 尾巴 | 节点 7：工程承压 |
| 2:35–3:00 | 故障演练剪辑（5×30s）或 `make chaos` 尾巴；收尾 AI 挂、出价继续 | 节点 8 + V9 P3：韧性收束 |

Keep a terminal visible running `make demo` in parallel — the scrolling
`CHAOS_OK` / `✓ ... PASSED` lines are the "not a mockup" proof judges respond to.

---

## 3. Anti-snipe (node 4) · 反狙击演示

`e2e-dummy-bid` does a single bid and exits before the timer, so it does **not**
drive an `AUCTION_EXTENDED`. Show node 4 one of two ways:

- **Live (preferred for narration):** in `room.html`, place a bid inside the
  anti-snipe window (last N seconds) — the countdown extends and the
  `extendCount` badge bumps. This is the most legible on camera.
- **Assertable:** the timer + boundary behavior is already covered by
  `make chaos-timer` (LIVE outlives `endAtMs` when the timer is disabled; hammers
  to `SOLD` within a scan tick when re-enabled), and `AUCTION_EXTENDED` semantics
  are unit-tested in the server package.

> Node4 is now first-class in demo smoke: use `make web-smoke-antisnipe` to run
> the live + late-bid + `AUCTION_EXTENDED` assertion path, and keep the UI
> demonstration as the on-camera fallback.

If you need to visibly exercise state patching during rehearsal (for judges asking
for coalescing on-wire, especially when using small-room smoke), set
`ROOM_STATE_PATCH_MIN_VIEWERS=10` in the rehearsal shell before `make demo` so
the room patch path is triggered sooner without changing production defaults.

If you're specifically validating the adaptive fanout behavior:
- `ROOM_STATE_PATCH_ADAPTIVE=true`
- `ROOM_STATE_PATCH_ADAPTIVE_MIN_BIDS=1` (or more, to defer coalescing until the room has seen N bid/extend events)

Use adaptive mode when you want big-room bursts to be coalesced but still keep small
rooms in direct-broadcast mode at first.

---

## 4. Fallback ladder · 兜底梯度

Rehearse **all three** on 2026-06-09. Never debug live — drop one rung.

1. **Public deploy** (primary) — `<DEPLOY_URL TBD · @PDGGK>`. Pre-checks: health
   endpoint green, seed run, one manual bid 10 min before.
2. **Local Docker** (rung 2) — `make demo` on the presenter's laptop. This is
   why the path is `make`-driven: the exact same assertions run offline. Have the
   stack pre-warmed (`make up && make seed`, or `make web-smoke-prepare` before T6 smoke rehearsals) so cold-build time isn't on camera.
3. **Backup recording** (rung 3) — pre-recorded full run + the 5 chaos clips (see
   §5). Play if both network and laptop fail.

Decision rule: if the primary isn't green at **T-10 min**, present from rung 2;
if rung 2 isn't green at **T-2 min**, play rung 3. No live debugging on stage.

---

## 5. Backup recording shot list · 备播清单 (@PDGGK)

Pre-record so rung 3 is complete (each is independently playable):

- [ ] Full §12 path (admin → room → evidence card), ~3 min, clean audio
- [ ] `make chaos` terminal run (or 5× 30s clips: ai / redis / mysql / ws / timer) showing `CHAOS_OK` + self-heal
- [ ] `make load` + Grafana panel: 500/50, p95, **seq gap = 0**
- [ ] Evidence card hash-chain expand (`prev_hash → curr_hash`, first 8 hex)
- [ ] AI-offline moment: badge flips "拍卖师暂离", bidding continues (V9 P3)

---

## 6. Pre-demo checklist · 演示前检查

- [ ] 演练闭环模板已填（`docs/rehearsal-closure-checklist.md`）并附上签名时间与 commit
- [ ] 若新建复盘 Issue，已在模板 `rehearsal-closure` 中同步同一清单
- [ ] 复盘 issue 的第一段已固定包含以下字段：Owner / Owner deadline / 并发规模 / 目标 URL / Evidence dir / Commit / 时间戳，减少口头约定
- [ ] 证据目录口径按 `docs/rehearsal-closure-checklist.md` 固定：
  - 远端演练：填写 `DEPLOY_REHEARSAL_OUT_DIR`（默认 `.deploy-rehearsal-<timestamp>`）
  - 本地 10万演练：填写 `.load-100k-rehearsals/<label>`
  - 单房间二价门禁（固定 1 房间、10万压测）：固定标注 `single-room`，并给出 `make load-100k-single-room-rehearsal-gate` 结论
  - 建议正文可直接粘贴：

    ```text
    - Owner: PDGGK
    - Owner deadline: 2026-06-07
    - 并发规模: 10k (2k×4 shards)
    - 目标: https://... / auc_...
    - Evidence dir: .deploy-rehearsal-20260609-090000 / .load-100k-rehearsals/superstretch-20260609
    - Commit: <git sha>
    - 复盘时间戳: 2026-06-07T08:00:00Z
    - 单房间二价门禁: PASS（`make load-100k-single-room-rehearsal-gate`）
    - 单房间门禁参数: `--shards 1 --auction-mode VICKREY`
    - 关键二价核验: winner_pay = runner_up_pay
    ```

- [ ] `make demo` green on the presenter laptop (full path) — **2026-06-09**
- [ ] `make demo-smoke` green in CI (orchestration wiring intact)
- [ ] Public deploy health-green + seeded + one manual bid (T-10 min)
- [ ] Backup recording + 5 chaos clips on local disk (not only cloud)
- [ ] Grafana panel bookmarked + datasource live (`infra/grafana`, `infra/prometheus`)
- [ ] **选做（演练）** `make load-100k`（外部压测机）或 `make load-100k-single-room-rehearsal-gate` 或 `make deploy-perf-rehearsal-100k`，并归档《super-stretch》结果（非 P0）
- [ ] Two browser tabs pre-opened (admin + room), sound on for AI/auctioneer audio
- [ ] `AI uses Doubao, demo runs mock` line ready (the key was deprovisioned; mock path is honest + reproducible)
