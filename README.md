# Lumen Auction · 直播实时竞拍系统

> **字节跳动 · 抖音电商 AI 全栈挑战赛**参赛项目 — 对应赛题「实时竞拍大师」。
> A real-time live-streaming **auction kernel** for known, single, high-value items: sellers publish goods, confirm AI-drafted facts, freeze rules, run a real-time bid loop, hammer, and close with an **auditable order + evidence chain**.

<p align="left">
  <code>Go (Gin/Fiber + Gorilla WS)</code> ·
  <code>React + TypeScript</code> ·
  <code>MySQL 8 + Redis</code> ·
  <code>Redis Lua 原子裁决</code> ·
  <code>Replay Verifier</code>
</p>

**Status / 状态**：trunk-driven `T0…T10`｜当前节点 **T6**（Replay Verifier + hash 校验 UI；T0–T5 已完成）｜内部 freeze **2026-06-08**｜对外 D-day **2026-06-10**。

---

## Table of Contents · 目录

- [1. What it is · 一句话定位](#1-what-it-is--一句话定位)
- [2. Scoring alignment · 评分对齐](#2-scoring-alignment--评分对齐)
- [3. Design invariants · 核心不变量](#3-design-invariants--核心不变量)
- [4. Architecture · 架构](#4-architecture--架构)
- [5. Repo layout · 仓库结构](#5-repo-layout--仓库结构)
- [6. Quick start · 快速开始](#6-quick-start--快速开始)
- [7. Contracts (the seam) · 契约（系统接缝）](#7-contracts-the-seam--契约系统接缝)
- [8. State machine · 状态机](#8-state-machine--状态机)
- [9. WebSocket protocol · WS 协议](#9-websocket-protocol--ws-协议)
- [10. Redis keys, Lua & MySQL · 数据契约](#10-redis-keys-lua--mysql--数据契约)
- [11. AI sidecar (non-adjudicating) · AI 旁路](#11-ai-sidecar-non-adjudicating--ai-旁路)
- [12. Evidence chain & Replay Verifier · 证据链与回放校验](#12-evidence-chain--replay-verifier--证据链与回放校验)
- [13. Acceptance metrics (SLO) · 可验收指标](#13-acceptance-metrics-slo--可验收指标)
- [14. Trunk roadmap T0–T10 · 主干路线图](#14-trunk-roadmap-t0t10--主干路线图)
- [15. CI gates & testing · CI 门禁与测试](#15-ci-gates--testing--ci-门禁与测试)
- [16. Security baseline · 安全基线](#16-security-baseline--安全基线)
- [17. Compliance scope · 合规边界](#17-compliance-scope--合规边界)
- [18. Collaboration · 协作模式](#18-collaboration--协作模式)
- [19. Docs index · 文档索引](#19-docs-index--文档索引)

---

## 1. What it is · 一句话定位

**Lumen Auction** 是面向高价值非标品的**直播竞拍闭环系统**。三个展示点 / three things it sells on:

1. **实时竞拍硬功 · Real-time hard skills** — WebSocket 出价、Redis Lua 原子裁决、单调 `seq`、断线 catchup、排行榜、反狙击 (anti-snipe)、定时落锤 (timer hammer)。
2. **可裁决 + 可回放 · Adjudicable & replayable** — Redis Lua 单脚本写入 + Redis Stream（ID = `<seq>-0`）+ MySQL 幂等投影 + **Replay Verifier 三方一致校验** (Stream ↔ Redis snapshot ↔ MySQL projection)。
3. **AI 旁路创新 · AI as a non-authoritative sidecar** — VLM facts draft（卖家 confirm 后才进核心）、LLM 拍卖师文案（guardrail + 禁词后置）。**AI 永不参与出价裁决** / AI never touches bid acceptance, winner, price, or terminal state.

> 关键句 / In one line：把「实时正确性」做成可证明的硬功，把 AI 做成可下线的旁路。

---

## 2. Scoring alignment · 评分对齐

赛题 PDF 的评分拆分即本项目的规划镜头 / The PDF rubric is the planning lens（`docs/spec/`）:

| 权重 Weight | 维度 Dimension | 本项目如何命中 How we hit it |
|---:|---|---|
| **50%** | 技术实现与工程完整度 · Implementation & completeness | 完整拍卖闭环 + CI 门禁 + 命名回归测试套件 (§15) |
| **25%** | 技术深度与创新 · Technical depth & innovation | Lua 原子热路径、单 `seq` 无 gap、Replay Verifier、hash chain (§12) |
| **15%** | AI 使用与落地效果 · AI usage & landing | VLM/LLM 旁路 + 可追溯 `docs/ai-usage/` 日志 (§11) |
| **10%** | 项目材料 · Project materials | README / 压测报告 / 演示脚本 / 5 段故障演练录像 (§14 T8–T10) |

不是只做漂亮房间 UI，也不是只做基础设施 demo —— 必须展示**完整闭环 + 实时正确性 + 可追溯 AI + 清晰材料**。

---

## 3. Design invariants · 核心不变量

这些是 RFC v2 §0 冻结的工程边界 (frozen engineering boundaries)，整个仓库依此实现，**不轻易重开** / not to be casually reopened:

| # | 不变量 Invariant | 说明 Why |
|---|---|---|
| ① | **Hash tag `{<aid>}` 同 slot** | 房间内多 key Lua 落在同一 Redis slot，集群下不 `CROSSSLOT`。 |
| ② | **Lua validate-before-write** | Lua 无 rollback → 先 type-guard + 校验，再写；业务代码**不得**直接改热 key。 |
| ③ | **Stream ID = `<seq>-0`** | 事件日志 ID 与单调 `seq` 绑定，可回放、可对齐。 |
| ④ | **Redis TIME 权威，边界 `>=`** | 时间裁决唯一源是 Redis TIME；过期边界 `now >= endAtMs`。 |
| ⑤ | **Dedupe = Hash，重试返原 ack** | 同 `clientBidId` 重试逐字节返回原始 ack（**不是** `DUPLICATE`-as-error）。 |
| ⑥ | **单一 `seq`** | 每个 auction 仅一个单调序列，严格无 gap（并发下亦然）。 |
| ⑦ | **AOF everysec + 不承诺金融级** | Redis 挂 → 显式 `ERR_AUCTION_PAUSED`，**绝不**经 MySQL 静默接单。 |
| ⑧ | **WS `bufferedAmount` 1MB / 4MB** | 慢客户端背压阈值；关键消息 (bid ack) 不被软流量阻塞。 |
| ⑨ | **视频 non-authoritative** | 视频/AI 只做展示与辅助文案，**非**价格/胜者/时间裁决源。 |

约定 / Conventions：金额在所有 JS 可见边界 (WS / REST / evidence / AI) 一律为 **string**（避免 JS number 失真）；线上时间字段为 **`endAtMs`**（DB 为 `end_at`）；Lua 脚本命名 `place_bid.lua` / `close_auction.lua` / `cancel_auction.lua` / `start_auction.lua` / `freeze_rules.lua`，**禁止** `*_v2.lua`（CI grep 守门）。

---

## 4. Architecture · 架构

四层架构 / four layers — Client → Edge → Core → Data。**WS Gateway 水平扩展且不碰拍卖真相；Bid Engine 单实例 + Redis Lua 原子裁决。** 详见 [`docs/architecture.md`](docs/architecture.md)。

```text
┌──────────────────────────────────────────────────────────────┐
│ Client Layer · 客户端                                         │
│  Admin PC               Mobile H5            Load Bot          │
│  商品上架/规则/订单      直播间/出价/榜单      500/50 P0 · 1k/100 S │
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST               │ WebSocket
┌───────────────▼────────────────────▼─────────────────────────┐
│ Edge Layer · 边缘                                             │
│  API Gateway · Auth & Rate Limit · REST BFF                   │
│  WebSocket Gateway：room 隔离 / 心跳 / lastSeq 恢复 / 广播      │
│  （水平扩展，never mutates auction truth）                     │
└───────────────┬────────────────────┬─────────────────────────┘
                │ REST cmd/query     │ bid command
┌───────────────▼────────────────────▼─────────────────────────┐
│ Core Layer · 核心（单一职责）                                  │
│  Auction Service     Bid Engine          Timer Worker          │
│  开拍/取消/冻结规则    place_bid.lua（唯一  close_auction.lua    │
│                       bid 入口，原子）     （唯一过期裁决）       │
│  Order Service       Persistence Worker   Metrics API          │
│  幂等订单             Stream → MySQL 幂等   压测指标            │
└───────────────┬────────────────────┬─────────────────────────┘
                │ atomic write       │ stream consume
┌───────────────▼────────────────────▼─────────────────────────┐
│ Data Layer · 数据                                             │
│  Redis（实时唯一热源 · hot authoritative path）                │
│   auction:{id}:state / :leaderboard / :events(Stream)         │
│   :dedupe:{userId} / auction:active                           │
│  MySQL（事实库 · fact & audit store）                          │
│   users / products / auctions / auction_rules                 │
│   bids / orders / auction_events / ai_usage_logs              │
└──────────────────────────────────────────────────────────────┘
```

数据规则 / data rules：Redis 是实时热路径 (AOF everysec)；MySQL 存事实/审计/AI 日志供回放；**Pub/Sub 仅作唤醒/fanout，catchup 与持久化走 Redis Stream**；AI Sidecar 解耦可降级。

---

## 5. Repo layout · 仓库结构

```text
live-auction-system/
├── apps/
│   ├── lumen/                  # Go 主服务 (monolith, --mode 可选 gateway)
│   │   ├── cmd/lumen/          # 入口；子命令含 `seed`
│   │   └── internal/
│   │       ├── server/         # ws.go / api.go / timer.go / persistence.go
│   │       │                   # perf.go / verify.go / e2e.go / seed.go
│   │       ├── lua/            # place_bid / close_auction / cancel_auction
│   │       │                   # start_auction / freeze_rules （5 个脚本）
│   │       ├── seqguard/       # 客户端 seq 守卫（丢弃乱序/重复帧）
│   │       ├── store/          # Redis + MySQL 存储 + Lua 集成测试
│   │       ├── model/          # 纯函数状态机 / 规则
│   │       ├── auth/           # dev-login / ownership / Origin 校验
│   │       └── config/
│   └── ai-sidecar/             # 非裁决 AI 旁路 (VLM facts / LLM 拍卖师)
├── proto/                      # ★ canonical 契约（the seam，全员 approve 边界）
├── docs/                       # 决策真相源 + 架构 / 状态机 / 协议 / 压测 / dev-log
│   └── spec/                   # 赛题 PDF
├── web/                        # admin.html / room.html / index.html
├── infra/                      # docker-compose.yml + redis.conf + mysql init
├── Makefile                    # demo path = 一串 make 目标
└── .github/workflows/ci.yml    # CI 门禁
```

---

## 6. Quick start · 快速开始

**前置 / Prereqs**：Docker（含 Compose v2）跑全栈；本地纯 Go 检查需 Go 1.22。

```bash
# 1) 复制环境变量模板（密钥永不进 git；本地/部署凭据走私有渠道）
cp .env.example .env        # secrets stay local — see §16

# 2) 一键起全栈：redis + mysql + lumen + ai-sidecar
make up                     # docker compose up -d --build --wait

# 3) 灌入 dev 种子（user + product + 一个 LIVE auction，幂等）
make seed

# 打开 / open:
#   Admin  后台：http://localhost:8080/admin.html
#   Mobile H5  ：http://localhost:8080/room.html?auction=auc_demo
```

**Demo path = make targets**（每个 demo 节点都有机器可验命令，非仅录屏）:

| 命令 Command | 作用 What it does | 验收 Gate |
|---|---|---|
| `make up` / `make down` | 起 / 停全栈（`down` 清卷） | health `/healthz` 全绿 |
| `make seed` | 幂等 dev 种子 | — |
| `make e2e-dummy-bid` | T1 端到端：上架→facts→冻结→开拍→出价→ack→持久化 | **exit 0** 即通过 |
| `make perf-smoke` | T2 性能地板检查 (ack/broadcast p95 vs 兜底预算) | floor-check |
| `make verify` | Replay Verifier，期望 `consistent` | mismatch/hash_break → exit≠0 |
| `make build / vet / test / fmt` | 纯 Go：编译 / vet / 测试 / 格式化 | CI 用 |
| `make guard` | 禁 `*_v2.lua`、禁真实 DOUBAO endpoint id | CI grep |

> 测试需 Redis + MySQL：CI 以 service container 提供，**所有集成测试都是真实门禁，CI 内零 skip**（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

---

## 7. Contracts (the seam) · 契约（系统接缝）

低耦合靠**契约即接缝**：所有跨组件耦合收敛到 `proto/`。改契约 = 改 seam = **全员 approve**（@Eliaaazzz + @PDGGK + @fariZzzz）；组件 `internal/` 内的改动 leader 即可推进。`proto/` 为 canonical，`docs/` 同名文件为指针。

| 契约 Contract | Canonical 文件 | 约束 Key bounds |
|---|---|---|
| WS envelope | [`proto/ws-envelope.md`](proto/ws-envelope.md) | `type` SCREAMING_SNAKE · 4 channel · 心跳/重连/catchup · `amountCents` string · `endAtMs`/`serverTimeMs` |
| Redis keys + Lua | [`proto/redis-keys.md`](proto/redis-keys.md) | hash tag `{<aid>}` 同 slot · state Hash（单 `seq`）· Stream ID `<seq>-0` · dedupe Hash |
| Error codes | [`proto/error-codes.md`](proto/error-codes.md) | Lua 内部码 ↔ 线上 wire 码映射表 |
| DB schema | [`proto/db-schema.md`](proto/db-schema.md) | 事实/事件表 + 唯一约束 + `event_hash`/`prev_hash` |
| AI events | [`proto/ai-events.md`](proto/ai-events.md) | VLM schema（含 `high_risk_fields_disclaimer`）+ LLM guardrail + SSRF 白名单 |
| State machine | [`docs/state-machine.md`](docs/state-machine.md) | canonical 终态 + 边界 `>=` + Lua 校验顺序（见 §8） |

> 规划中 (DRAFT, per Plan V9 §6)：`proto/openapi.yaml`（REST + snapshot fallback shape）与 `proto/evidence-card.md`（证据卡字段 + hash 算法 + canonical 序列化）。

---

## 8. State machine · 状态机

canonical 状态契约 = [`docs/state-machine.md`](docs/state-machine.md)。`AUCTION_EXTENDED` 是 **event 不是 state**；过期裁决也不是独立持久态。

```text
DRAFT ──(confirm AI facts + freeze rules)──▶ SCHEDULED
                                                │ start_auction.lua
                                                ▼
                                              LIVE ──┐ place_bid.lua（含 anti-snipe 分支）
   ┌──────────────────────────────────────────┤
   │ cap reached / now>=endAtMs & 有最高价 ─────▶ SOLD ──(order)──▶ ORDER_CREATED
   │ now>=endAtMs & 无出价 ─────────────────────▶ NO_BID
   └ 异常取消 (DRAFT/SCHEDULED/LIVE 任一) ───────▶ CANCELLED   ← cancel_auction.lua
```

- 终态 (`SOLD` / `NO_BID` / `CANCELLED` / `ORDER_CREATED`) 拒绝新 bid，wire code = `ERR_NOT_LIVE`（用户文案 `after_hammer` 映射到此码）。
- **落锤边界 race（确定性裁决）**：`now >= endAtMs` 时到达的 `BID_PLACE` 与 `close_auction.lua` 竞争 → `place_bid.lua` 返 `ERR_AFTER_END`、`close_auction.lua` 返 `OK_SOLD`（落锤优先，迟到 bid 必拒）。
- 反狙击：在 `place_bid.lua` **同一脚本内**更新 `endAtMs` + `extendCount` + 写 Stream + 广播 `AUCTION_EXTENDED`（无独立 `extend.lua`）。
- `reserve`（保留价）为 **P1 OPEN DECISION**，未经全员 ratify 前不进 P0 状态/schema/Lua。

---

## 9. WebSocket protocol · WS 协议

完整契约见 [`proto/ws-envelope.md`](proto/ws-envelope.md)（canonical）/ [`docs/ws-protocol.md`](docs/ws-protocol.md)。JSON camelCase；money 字段为 string。

**Envelope**

```ts
type WsEnvelope<T = unknown> = {
  type: string            // SCREAMING_SNAKE
  auctionId?: string
  seq?: number
  serverTimeMs: number    // 客户端据此校准 serverClockOffsetMs
  data: T
}
```

| C→S | 作用 | S→C | 作用 |
|---|---|---|---|
| `ROOM_JOIN {auctionId,lastSeq?}` | 进房；`lastSeq` 触发 catchup —— 缺失的 Stream delta 通过**同一组 server→client 类型**重放（无独立 `CATCHUP_EVENTS`），`gap>200` → 仅快照 | `ROOM_SNAPSHOT` | 进房时房间状态：现价/胜者/`endAtMs`/`seq`/status |
| `BID_PLACE {clientBidId,amountCents}` | 出价 | `BID_ACCEPTED` / `BID_REJECTED` | ack（含 `seq`/`endAtMs`/status）/ 拒绝（含 `code`） |
| `PING` | 心跳 | `AUCTION_EXTENDED` | 反狙击延时（event，非 state） |
| | | `AUCTION_SOLD` / `AUCTION_NO_BID` / `AUCTION_CANCELLED` | 终态事件 |
| | | `PONG` | 心跳应答 |

> 离房走 WS close（无显式 `ROOM_LEAVE` envelope）；聊天不在 V9 scope。**用户被超越提示** = `BID_REJECTED.code=ERR_TOO_LOW` + 前端 inline toast（roadmap：proxy bidding 落地后接 `USER_OUTBID`，见 [RFC #58](../../issues/58)）。

**Error / result codes**：`OK_ACCEPTED` `OK_SOLD` `DUPLICATE` `ERR_NOT_LIVE` `ERR_TOO_LOW` `ERR_AFTER_END` `ERR_RATE_LIMITED` `ERR_AUCTION_PAUSED` `OK_CANCELLED` `OK_NO_BID` `ERR_NOT_DUE` `ERR_ALREADY_TERMINAL` `ERR_NOT_ALLOWED`。`DUPLICATE(previousResult)` 是幂等重放，**非**客户端拒绝。

**背压 / backpressure（两 lane，T5）**（不变量 ⑧）：每连接分 **critical** lane（bid ack、`AUCTION_*` 事件、`ROOM_SNAPSHOT`、catchup —— socket 开着绝不静默丢；满则 force-close 让客户端重连重放）与 **best-effort** lane（`PONG`，以及未来的 presence/chat —— 满则丢该帧、保连接）。critical 以优先级排空，一个慢客户端不拖垮房间广播；`bufferedAmount` 1MB/4MB 阈值在 T8 压测下调优。

**倒计时 / countdown**：`remainingMs = endAtMs - (clientNowMs + serverClockOffsetMs)`，`serverClockOffsetMs` 由快照/事件里的 `serverTimeMs` 校准。

---

## 10. Redis keys, Lua & MySQL · 数据契约

详见 [`docs/redis-keys.md`](docs/redis-keys.md) 与 [`docs/mysql-schema.md`](docs/mysql-schema.md)。

**Redis 热键（同 hash tag `{<aid>}`）**：`:state`(Hash, 单 `seq`) · `:leaderboard`(ZSET) · `:dedupe:{userId}`(Hash, TTL 24h) · `:events`(Stream, ID `<seq>-0`) · `:pub`(Pub/Sub) · `auction:active`(ZSET, score=`endAtMs`) · `room:{<aid>}:online`。

**P0 Lua 脚本与返回码**（Lua 无 rollback → validate-before-write）：

```text
place_bid.lua(aid,userId,clientBidId,amountCents,requestId)
  → OK_ACCEPTED(seq,amount,endAtMs,extended) | OK_SOLD | DUPLICATE(prev)
  | ERR_NOT_LIVE | ERR_TOO_LOW | ERR_AFTER_END | ERR_RATE_LIMITED | ERR_AUCTION_PAUSED
close_auction.lua(aid)      → OK_SOLD | OK_NO_BID | ERR_NOT_DUE(msRemaining) | ERR_ALREADY_TERMINAL
cancel_auction.lua(aid,sellerId,reason) → OK_CANCELLED | ERR_ALREADY_TERMINAL | ERR_NOT_ALLOWED
```

接受金额 = `min(amountCents, capPriceCents)`；成功后递增单一 `seq` → 写 Stream → 再 publish。

**MySQL 唯一约束（证明无重复 / 可回放）**：`bids UNIQUE(auction_id, seq)`、`bids UNIQUE(auction_id, user_id, client_bid_id)`、`orders UNIQUE(auction_id)`、`auction_events UNIQUE(auction_id, seq)`。

---

## 11. AI sidecar (non-adjudicating) · AI 旁路

两个展示点，**均不参与裁决** / two demo points, never authoritative:

1. **VLM facts draft** — 从商品图起草事实卡，高风险字段带 `high_risk_fields_disclaimer`（标注「卖家声明 / AI 未验证」），**卖家 confirm/edit 后**才能进核心、才能开拍。
2. **LLM 拍卖师** — 纯文本流式控场，4 个触发点：开拍 / 跳涨 / 冷场 30s / 落锤；guardrail + 禁词后置 regex；**AI 下线 → 徽章提示，核心竞拍照常继续**（`make e2e-ai-offline` 断言出价仍 ack）。

安全 / safety：VLM 取图走白名单 origin、禁私网/IMDS、限大小+超时、不跟随 redirect；product 文本一律当**不可信数据**（防 prompt injection 伪造真伪声明）。AI 使用全程记录于 [`docs/ai-usage/`](docs/ai-usage/README.md)，公开材料用脱敏摘要，绝不记录 prompt 原文/密钥。

---

## 12. Evidence chain & Replay Verifier · 证据链与回放校验

**证据卡 / evidence card**：facts confirmed snapshot + 冻结规则 + 完整成功 bid timeline + `seq` 区间 + **`events_hash` 链**。

**Replay Verifier**（P0，T6）：重放 Stream，比对 **Stream ↔ Redis snapshot ↔ MySQL `auction_events` 三方一致**，输出 `consistent` / `mismatch_at_seq=X` / `hash_break_at_seq=Y`；`make verify` 在不一致时 **exit≠0**（CI/demo 门禁，非仅截图）。

**Hash chain 威胁模型（精确，不过度宣称）**：`event_hash = HMAC(key, prev_hash ‖ canonical(seq, event_type, payload))`；HMAC key 不与业务 DB 同库存放，chain head 在证据卡公示。**能防**事后单点篡改历史 payload（链断即 `hash_break_at_seq`）；**不等于**外部公证/区块链锚定。若 key 与写事件进程同库可读，措辞即降为「integrity/consistency check」。

---

## 13. Acceptance metrics (SLO) · 可验收指标

**正确性（0 容忍，全部为命名 CI 测试）**：`(auction_id, seq)` 唯一且并发下严格单调 **seq gap = 0**；同 `clientBidId` 重试返原 ack；终态拒 bid = `ERR_NOT_LIVE`；落锤 race pinned oracle；Replay Verifier `consistent`（**在压测后的 auction 上跑**）。

**性能 / performance**（区分 P0-gate 与 Stretch）：

| 指标 Metric | P0 gate | 兜底 Floor | 类别 |
|---|---|---|---|
| `BID_ACCEPTED` ack p95 | **< 80 ms** | < 200 ms | P0 gate |
| Broadcast p95（Bid Engine → 末端观众） | **< 150 ms** | < 500 ms | P0 gate |
| Hammer 广播 p95 | **< 500 ms** | < 2 s | P0 gate |
| Reconnect catchup 200 events | **< 1 s** | < 3 s | P0 gate |
| 单房 **500 connected + 50 active** | 稳定 60s+ | — | P0 gate |
| 1k connected + 100 active | ack p99 < 100ms / broadcast p99 < 300ms | — | **Stretch（非 gate）** |

> 热路径预算：`place_bid.lua` exec **p99 < 5 ms**（单线程 Redis，超则拆脚本 / 把 leaderboard ZADD 移出热路径）—— 这是 ack p95 < 80ms 的前置 gate。压测报告须含机器规格、gateway 拓扑、拒绝分布、慢客户端 `bufferedAmount` 曲线、`place_bid.lua` 耗时直方图、Stream/Persistence lag。

---

## 14. Trunk roadmap T0–T10 · 主干路线图

推进单位是**一条每天可演示的 trunk**（替代旧的 4-Sprint）。每个 T = demo path 上一个可运行节点，跑完始终 end-to-end runnable。真相源 = [Issue #1 Plan V9](../../issues/1)。

> 主轴 / demo path：`seller create → AI facts → freeze rules → live bid → hammer → order/evidence → replay/load/materials`

| T | 节点 Step | 这步后能演示 | 状态 |
|---|---|---|:--:|
| **T0** | 契约冻结 + 骨架启动 | 契约可消费；`make up` 全绿；CI 门禁上线 | ✅ |
| **T1** | Dummy bid roundtrip | 上架→facts→冻结→开拍→1 bid→ack+广播+持久化 | ✅ |
| **T2** | 原子 bid core | 并发出价正确裁决 + 排行榜 + perf smoke | ✅ |
| **T3** | Hammer + 反狙击 + cancel + durable stream | 到点自动落锤、最后一刻延时、异常取消、seq gap=0 | ✅ |
| **T4** | Persistence + order + evidence v0 | 落锤生成幂等订单 + 证据卡时间线 + hash 链 | ✅ |
| **T5** | Multi-gateway + catchup | 水平 gateway + 断线重连无缝续看（背压双 lane） | ✅ |
| **T6** | **Replay Verifier + hash 校验 UI** | 一键验证三方一致 + 证据卡 verify 按钮 | ⏳ 进行中 |
| **T7** | AI sidecar 全量（非裁决） | AI 控场冒泡 + 可下线 | ⬜ |
| **T8** | 500/50 压测 + perf 调优 | 稳定压测 + 达标延时 + dashboard | ⬜ |
| **T9** | 5 项故障演练 | MySQL/WS/Timer/AI/Redis 故障可降级+自愈+录像 | ⬜ |
| **T10** | Demo materials + freeze | 公网 deploy + 本地 fallback + 备播 + 3-min demo | ⬜ |

**Stretch lane（并行、可砍、不阻塞）**：1k/100 压测、风控黄红灯、动态加价建议、邮箱 OTP、TTS、物理拆 socket、reserve（先 ratify）。

---

## 15. CI gates & testing · CI 门禁与测试

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）以 **Redis + MySQL service container** 跑全部集成测试 —— **CI 内零 skip**，任何 `--- SKIP` 即失败。required checks：

1. `go mod tidy` 干净 → 2. `gofmt` → 3. `go vet` → 4. `go build` → 5. **`go test -race`**（redis + mysql 真实集成）→ 6. guards（禁 `*_v2.lua`、禁真实 DOUBAO endpoint id、`proto/` 契约文件存在）→ 7. e2e job（`make up` + `/healthz` + seed + `e2e-dummy-bid` + `perf-smoke` + `verifier`）。

**覆盖率分区 floor**：状态机（纯函数）≥ 95%；Lua 每个 return code 须有 harness 覆盖；envelope codec / catchup / persistence-idempotency / order-idempotency 各有命名测试；全局 ≥ 80%。

**§4.1 → 命名回归套件**（从 T3 起每次 merge 跑）：并发 seq gap=0 · 同 `clientBidId` 逐字节同 ack · 终态拒 bid `ERR_NOT_LIVE` · 已终态 close → `ERR_ALREADY_TERMINAL`、未到期 → `ERR_NOT_DUE` · anti-snipe `endAtMs↑` + Stream 事件 · 落锤 race pinned · cancel → `OK_CANCELLED` + `AUCTION_CANCELLED`。

---

## 16. Security baseline · 安全基线（T1 起生效）

| 面 Surface | 约束 Constraint |
|---|---|
| **Auth** | `ENABLE_DEV_LOGIN` 默认 false，非 dev 硬关（dev compose 显式 opt-in 设 `"true"`，见 `infra/docker-compose.yml`）；seller 动作服务端校验调用者**拥有该 auction**，**绝不信任 client 传的 `sellerId`**；非本地 `JWT_SECRET=change-me-local-only` 时启动失败。 |
| **WS** | handshake 校验 token 并绑连接；**Origin 白名单**（`FRONTEND_ORIGIN`）防 CSWSH；max frame size；每连接出价 rate limit (`ERR_RATE_LIMITED`)。 |
| **AI / SSRF** | VLM 取图走白名单 origin、禁私网/IMDS、限大小+超时、不跟随 redirect；product 文本当不可信数据防 prompt injection。 |
| **Secrets** | 密钥**永不**进 git / issue / PR / commit / log / 截图；仓库只留 `.env.example`，本地与部署凭据走私有渠道 / GitHub Secrets；secret scan 跑全 commit + 全历史 baseline。 |
| **Upload** | 图片按 magic-byte 校验 MIME + 限大小 + 服务端随机文件名 + `X-Content-Type-Options: nosniff`；`image_url` 套 SSRF 白名单。 |

---

## 17. Compliance scope · 合规边界

**透明的已知单品竞拍** / transparent, single, known-item auction。明确**不做** / explicitly out of scope：mystery box（盲盒）、抽奖 / random card break、平台真伪兜底/背书、真实支付/物流/售后承诺、数字分身。AI 输出显式标识、真人最终背书、LLM 受 schema 约束。

---

## 18. Collaboration · 协作模式

trunk-driven + dev-log + 全局 review（全员从全局视角 build / review，不切部门墙）。载体 = issue / PR / `docs/dev-log/`。

不变量 / invariants：人读 dev-log 判断方向与风险，AI 读 log 也读 code；**合同 / security / secret / 评分关键路径仍要人看 diff**；reviewer 有 **blocking authority**；契约改动 = 全员 approve（§7）。决策真相源 = [`docs/decisions.md`](docs/decisions.md)（与本 README 冲突时以 decisions.md 为准）。

---

## 19. Docs index · 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | **决策真相源 (SoT)** — 拍板记录 + single-source 收口 |
| [`docs/charter.md`](docs/charter.md) | 项目章程 + scope 分层 (P0/P1/P2) |
| [`docs/architecture.md`](docs/architecture.md) | 四层架构 + Edge/Core/Data 规则 |
| [`docs/state-machine.md`](docs/state-machine.md) | canonical 状态机契约 |
| [`docs/ws-protocol.md`](docs/ws-protocol.md) · [`docs/redis-keys.md`](docs/redis-keys.md) · [`docs/mysql-schema.md`](docs/mysql-schema.md) | WS / Redis+Lua / MySQL 契约 |
| [`proto/`](proto/README.md) | canonical 契约（the seam，全员 approve 边界） |
| [`docs/roadmap.md`](docs/roadmap.md) | Sprint baseline（已被 T0–T10 取代，保留为基线） |
| [`docs/ai-usage/`](docs/ai-usage/README.md) | AI 使用日志（可追溯证据） |
| [`docs/dev-log/`](docs/dev-log/) | 每节点开发叙事 |
| [`docs/diagrams/`](docs/diagrams/) | Mermaid：系统/状态机/出价/重连/落锤/ER/RBAC |
| [Issue #1](../../issues/1) · [Issue #2](../../issues/2) | Plan V9（T0–T10）· Architecture RFC v2 |

---

<sub>Lumen Auction · 直播实时竞拍系统 — ByteDance Douyin E-commerce AI Full Stack Challenge · 内部 freeze 2026-06-08 / 对外 D-day 2026-06-10.</sub>
