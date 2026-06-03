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
| 4 | 末 N 秒反狙击，倒计时延长 | "最后时刻出价自动延时，反阻击" | `make demo-auction` (+ UI live) | two `AUCTION_EXTENDED` (`extendCount` 1→2, bounded by `MaxExtensions`) |
| 5 | 落锤 → 证据卡 | "成交即生成证据卡：图/价/timeline + `events_hash`" | `make demo-auction` (→ `AUCTION_SOLD` + `eventsHash`) · `make verify-evidence` | demo-auction asserts hammer + non-empty `eventsHash`; verify-evidence: exit 0, no `hash_break` |
| 6 | Replay Verifier consistent | "Stream / Redis / MySQL 三方一致 + hash 链校验" | `make verify` | `consistent`; no `mismatch_at_seq` / `hash_break_at_seq` |
| 7 | 监控面板 500/50 | "500 在线 + 50 活跃出价，ack/broadcast p95 达标，**seq gap = 0**" | `make load` | p95 within §4.2 budgets; `seqGapCount=0`; post-load verify consistent |
| 8 | 故障演练 30s ×5 | "MySQL/WS/Timer/AI/Redis 各挂一段，证明降级 + 自愈" | `make chaos` | 5× `CHAOS_OK` + `✓ T9 PASSED · 5/5`; AI 挂时出价继续 (V9 P3) |

> `make demo` runs all of it automatically: nodes 1–3 (`e2e-dummy-bid`), **4–5
> (`demo-auction`: anti-snipe extend → hammer → evidence)**, 5 (`verify-evidence`),
> 6 (`verify`), 7 (`load`), 8 (`chaos`). Every node is now an assertion — node 4
> is no longer UI-only (see §3).

---

## 2. Three-minute script · 三分钟脚本

Pre-flight (before the clock): `make up && make seed` so the stack is warm.
Open two tabs: `/admin` (seller console) and `/room/auc_demo` (buyer room) — the
designed React app, served by lumen at `http://localhost:8080`.

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

## 2.5 Innovation cutaway · #114 模式亮点（可选 20–30 秒）

The main 3-minute path should stay focused. If the judges ask "what is the
innovation beyond English auction?", use a short cutaway backed by `make demo-smoke`:

```bash
make demo-sudden-death
make demo-sealed
make demo-vickrey
make demo-hybrid
make demo-allpay
make demo-prequalify
```

Narration points:

- **Sealed / Vickrey**: hidden bids stay private during LIVE, then reveal atomically at close.
- **HYBRID_REVEAL**: the room sees runner-up pressure, while the true leader is hidden until SOLD.
- **ALL_PAY**: show only as a **virtual coin event** — explicitly say **「虚拟币 · 非真实支付 · 非赌博」**. The evidence card exposes `settlement: "VIRTUAL_COINS_ONLY"`, and the backend verifier asserts there are zero normal `orders` rows.
- **PREQUALIFY**: a sealed parent seeds the formal auction's start price through `/spawn-formal`.

This cutaway is optional for timing, but the commands are not hand-wavy: every mode
demo asserts its own state/event/evidence invariant.

---

## 3. Anti-snipe (node 4) · 反狙击演示

`e2e-dummy-bid` does a single bid and exits before the timer, so it does **not**
drive an `AUCTION_EXTENDED`. That gap is now closed by **`make demo-auction`**
(`RunDemo`, `apps/lumen/internal/server/demo.go`) — the assertable form of demo
nodes 4–5:

1. starts a **short** auction whose anti-snipe window ≥ its duration, so the
   whole auction sits inside the window and any accepted bid extends
   deterministically (no flaky "land a bid in the last N seconds" timing);
2. bidder A bids → asserts `AUCTION_EXTENDED` with `extendCount == 1`;
3. bidder B (a competing snipe) bids → asserts `extendCount == 2`, bounded by
   `MaxExtensions=2`;
4. stops bidding → the Timer Worker hammers → asserts `AUCTION_SOLD`;
5. fetches the evidence card → asserts a non-empty `eventsHash` (chain head).

Prints `DEMO_AUCTION_ID=… · demo-auction: PASS · extendCount=2 → AUCTION_SOLD → eventsHash=…`.
Wired into `make demo` / `make demo-smoke` as node 3.

- **Live (preferred for narration):** in `/room/auc_demo`, place a bid inside the
  anti-snipe window — the countdown extends and the `extendCount` badge bumps.
  Most legible on camera; `make demo-auction` is the proof it actually fired.
- The timer + boundary behavior is *also* independently covered by
  `make chaos-timer` (LIVE outlives `endAtMs` when the timer is disabled; hammers
  to `SOLD` when re-enabled).

---

## 4. Fallback ladder · 兜底梯度

Rehearse **all three** on 2026-06-09. Never debug live — drop one rung.

1. **Public deploy** (primary) — `<DEPLOY_URL TBD · @PDGGK>`. Pre-checks: health
   endpoint green, seed run, one manual bid 10 min before.
2. **Local Docker** (rung 2) — `make demo` on the presenter's laptop. This is
   why the path is `make`-driven: the exact same assertions run offline. Have the
   stack pre-warmed (`make up && make seed`) so cold-build time isn't on camera.
3. **Backup recording** (rung 3) — pre-recorded full run + the 5 chaos clips (see
   §5). Play if both network and laptop fail.

Decision rule: if the primary isn't green at **T-10 min**, present from rung 2;
if rung 2 isn't green at **T-2 min**, play rung 3. No live debugging on stage.

---

## 5. Backup recording shot list · 备播清单 (@PDGGK)

Pre-record so rung 3 is complete (each is independently playable):

- [ ] Full §12 path (admin → room → evidence card), ~3 min, clean audio
- [ ] #114 mode cutaway: sealed reveal, Vickrey second-price, HYBRID hidden leader, ALL_PAY virtual-coin marker
- [ ] `make chaos` terminal run (or 5× 30s clips: ai / redis / mysql / ws / timer) showing `CHAOS_OK` + self-heal
- [ ] `make load` + Grafana panel: 500/50, p95, **seq gap = 0**
- [ ] Evidence card hash-chain expand (`prev_hash → curr_hash`, first 8 hex)
- [ ] ALL_PAY evidence marker: `settlement: "VIRTUAL_COINS_ONLY"` / 「虚拟币 · 非真实支付 · 非赌博」
- [ ] AI-offline moment: badge flips "拍卖师暂离", bidding continues (V9 P3)

---

## 6. Pre-demo checklist · 演示前检查

- [ ] `make demo` green on the presenter laptop (full path) — **2026-06-09**
- [ ] CI green for the demo atoms (`e2e-ai-offline`, `chaos-smoke`, `load-smoke`, frontend smokes); run `make demo-smoke` locally if wrapper-order confidence is needed
- [ ] Public deploy health-green + seeded + one manual bid (T-10 min)
- [ ] Backup recording + 5 chaos clips on local disk (not only cloud)
- [ ] Grafana panel bookmarked + datasource live (`infra/grafana`, `infra/prometheus`)
- [ ] Two browser tabs pre-opened (admin + room), sound on for AI/auctioneer audio
- [ ] #114 mode cutaway rehearsed, especially the ALL_PAY compliance wording
- [ ] `AI uses Doubao, demo runs mock` line ready (the key was deprovisioned; mock path is honest + reproducible)
