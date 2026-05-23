# 直播竞拍系统 (Live Auction System)

字节跳动 AI Full Stack 挑战赛参赛项目。

## 项目简介

实时直播竞拍平台，结合 AI 主持、AI 鉴价与防作弊能力，构建一个端到端的智能拍卖直播间。

## 关键词

- 实时直播 (WebRTC / SRS)
- 实时竞价 (WebSocket)
- AI 主播 / 智能助理 (LLM + TTS)
- AI 估价 / 鉴定
- 多人并发与高可用

## Quickstart (T1 — dummy bid roundtrip)

需要 Docker。详见 [#17](https://github.com/Eliaaazzz/live-auction-system/issues/17)。

```bash
make up              # 拉起 redis + mysql + ai-sidecar + lumen
make seed            # 写入 demo 数据
make e2e-dummy-bid   # T1 验收：完整 roundtrip，exit 0 即通过
make verify          # replay-verifier skeleton，期望 "consistent"
```

两 tab 人肉 demo：开 <http://localhost:8080/admin.html> 跑 seller flow，把生成的 room 链接在两个 tab 打开，一个出价两个都实时看到。

纯 Go 校验（CI 用，无需 Docker）：`make build`、`make vet`、`make test`、`make guard`。

## Repo map

```
proto/            契约（all-member approve seam）：ws-envelope / redis-keys / error-codes / db-schema / ai-events
apps/lumen/       单 Go binary（serve --mode / seed / e2e / verify）；internal/{config,auth,model,store,server,lua}
apps/ai-sidecar/  AI sidecar（T1 mock，独立进程便于 chaos）
web/              最薄 demo 页（admin 开拍 / room 出价）
infra/            docker-compose + redis.conf + mysql/init schema
docs/dev-log/     开发日志（#15 workflow）
.github/workflows/ci.yml   compile / vet / test / gofmt / guards / e2e
```

栈与边界以 `docs/decisions.md`（PR #13 SoT）为准：Go + React/TS + MySQL 8 + Redis；Redis Lua 拥有出价热路径。

