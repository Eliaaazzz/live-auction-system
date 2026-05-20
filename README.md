# Lumen Auction — 直播竞拍系统

字节跳动 AI Full Stack 挑战赛参赛项目。**2026-06-08 交付**（20 天 sprint）。

> Plan: [issue #1](https://github.com/Eliaaazzz/live-auction-system/issues/1) · Architecture: [issue #2](https://github.com/Eliaaazzz/live-auction-system/issues/2) · Workflow: [docs/WORKFLOW.md](docs/WORKFLOW.md)

## 项目主线

1. **实时竞拍硬功**：WebSocket 出价、服务端裁决、单调 seq、断线 catchup、排行榜、反狙击、落锤。
2. **状态一致性**：Redis Lua 原子写入 + Redis Stream 事件日志 + Postgres 异步持久化 + 证据卡可审计。
3. **AI 旁路创新**：VLM 辅助上架估价、LLM 拍卖师营造氛围，但 AI 不参与核心裁决。

## Monorepo 结构

```
apps/
  web/        React 18 + TypeScript + Vite + TanStack Query + Zustand   (@B)
  realtime/   Go 1.23 + Gorilla WebSocket + Redis Lua + Postgres        (@A)
  ai/         Python 3.11 + FastAPI + Qwen2-VL / Qwen2.5                (@C)
proto/
  ws-envelope.md      WebSocket envelope + error codes
  openapi.yaml        REST API contract
  ai-events.md        VLM / LLM / pricing contracts
  redis-keys.md       Redis keys + Stream schema + Lua scripts
docs/
  WORKFLOW.md         Branch / commit / sprint / contract rules
docker-compose.yml    本地一键起 dev 环境
.github/workflows/    CI for each app
```

## 本地起步

```bash
# 第一次：
docker compose up --build

# 之后：
docker compose up
```

- 前端：http://localhost:5173
- 实时 API：http://localhost:8080/api/healthz
- AI sidecar：http://localhost:8000/v1/healthz

## 团队分工

| 角色 | Owner | P0 范围 |
|---|---|---|
| Realtime Engineer | A | WS Gateway、Bid Engine、Redis Lua/Stream、状态机、catchup、压测 |
| Product Engineer | B | React 房间页、上架/规则配置、证据卡、API、Postgres schema、看板 |
| AI / Infra Engineer | C | AI Orchestrator、VLM facts draft、LLM 主持、Docker/CI、部署、观测 |

## 关键技术约束

- 所有金额用 **cents (BIGINT)**，禁止 float。
- 时间戳 **ms (UTC epoch)**。
- 所有 bid 必须经过 Redis Lua 单脚本原子裁决；Pub/Sub 只用于实时 fan-out。
- AI 输出在 `ai_logs` 表留痕（合规）。
- 不做 mystery box / 抽奖 / random card break。
