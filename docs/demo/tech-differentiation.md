# 技术差异化一页纸 — 评委评分点 → 代码实证

> 每条主张都给出文件路径或实测阈值;演示可复现入口见文末动作清单。
> 配套演示:`docs/demo/multi-gateway-demo.md`(multigw compose profile)。

## 1. 房间级 WebSocket 路由隔离(本次演示主线)

| 主张 | 实证 |
|---|---|
| 每房间独立注册表,零客户端即回收 | `hub.rooms map[auctionId]map[*Conn]` + leave 时 `len==0` 删房间(`apps/lumen/internal/server/ws.go:139,187-196`) |
| 网关无状态,加网关不改代码 | `--mode=all\|gateway` 都启动 `hub.subscribe`(`apps/lumen/internal/server/server.go:63-66`);设计注释「adding gateways needs no re-plumbing」(`ws.go:126-128`) |
| 房间事件走 Redis backbone,权威源是 Stream(Pub/Sub 仅唤醒) | `subscribe` 从 canonical Redis Stream 扇出,Pub/Sub 丢失有 2s sweep 兜底(`ws.go:412-424,58-60`) |
| 跨网关 seq 一致(本演示) | compose `multigw` profile:`lumen`(:8080, all)+`lumen-gw2`(:8081, gateway)+nginx LB(:8088);`apps/web/scripts/smoke-multigw.mjs` 断言一笔经 GW1 的出价在 GW2 客户端以**同 seq 同金额** 3s 内到达 |
| 写聚合:扇出突发合并为单次 syscall | 8 KiB flush-on-demand 写缓冲(`ws_coalesce.go:12-23`) |
| 万人房扇出坍缩 | `ROOM_STATE_PATCH(bidCountDelta)` 50ms 节拍/≥1000 观众时合并出价广播(`ws_state_patch.go:14-15,118-124`) |
| 背压有界:慢客户端不拖垮房间 | 协议预算 bufferedAmount 1MB/4MB(冻结,`docs/ws-protocol.md:58-65`);Go 实现 1024 帧 critical lane + code 4000 force-close→重连补帧(`ws.go:46,104`) |
| 实测容量 | 真公网 10k 并发全绿:ack p95 **0.46ms**、seqGap **0**(`docs/reports/2026-06-07-tier2-public-loadtest-10k-20k.md` 场景A);单网关天花板实测 **~15,777 连接 / ~50k bids/s**,瓶颈为网关 CPU/内存,崩溃自动重启且**正确性不破**(同报告场景B);公网就绪核查另见 `docs/reports/2026-06-06-public-locust-10k-beijing-readiness.md` |

## 2. 出价幂等性

| 主张 | 实证 |
|---|---|
| 重试回放原 ack,不是报错 | `place_bid.lua:32-44`:dedupe 以 **(auction, userId, clientBidId)** 为键,命中返回 `{'DUPLICATE', 原ack}`(TTL 86400s) |
| 裁决单点原子 | 一段 Redis Lua 完成 state/seller/amount/cap/dedupe/seq/anti-snipe/Stream/publish(`place_bid.lua:1`);Lua 无回滚,故所有 key 先 type-guard 再写(`:21-30`) |
| 客户端幂等令牌 | `crypto.randomUUID()` 生成 clientBidId(`apps/web/src/routes/LiveRoomRoute.jsx:363-367`) |
| HTTP→WS 双道切换安全 | 前端 HTTP 命令道优先、WS `BID_PLACE` 兜底(`LiveRoomRoute.jsx:118-134 submitBidCommand`);换道重试不会双扣——因为幂等在服务端 dedupe,与入口无关 |
| 网关 fast-reject 不破坏幂等 | Tier-C 快拒前 pipeline 预检 dedupe HEXISTS,重复重试必落 Lua 回放(`ws.go:1383-1386,1442-1443`);实测 fast-reject 吸收 99.97% 注定失败出价、ack p95 3.5ms@20k bids/s(Tier-2 报告场景C) |
| 隐藏对抗测试盯死边界 | `server/ws_t2_pdggk_hidden_input_test.go`、`store/lua_t2_hidden_unwinnable_first_bid_test.go`、`store/lua_t2_pdggk_hidden_money_precision_test.go` |

## 3. 跨端状态同步

| 主张 | 实证 |
|---|---|
| 单调 seq,验收 seq gap = 0(冻结) | Lua 单点铸 seq;压测网 `LOAD_*` 断言 seqGap==0(`infra/docker-compose.yml:128-137`);两份公网报告全程 seqGap=0 |
| 断线补帧:ROOM_JOIN(lastSeq) 从 Stream 重放 | 验收 **200 事件 < 1s**;`catchupMaxGap=200`(`ws.go:31-33`);冒烟 `apps/web/scripts/smoke-catchup.mjs` |
| gap 过大→快照救援 | 超过 200 直接发 ROOM_SNAPSHOT 而非海量重放(`ws.go:31-33`);REST 快照另有 `smoke-snapshot-fallback.mjs` |
| 服务器时钟校正 | 心跳回带 serverTs 算 offset,所有倒计时用 `serverNow()`(`apps/web/src/lib/clock.js`);房间 UI 可见 **Δms** 漂移芯片(`components/primitives.jsx:662`) |
| 手势级自救 | 下拉重同步 PullToResync(`apps/web/src/components/PullToResync.jsx`) |
| 延迟预算(冻结) | ack p95 < **80ms** · broadcast p95 < **150ms** · hammer p95 < **500ms**;P0 规模 500 连接 + 50 活跃(Stretch 1k+100) |

## 4. 前瞻性加分项

| 主张 | 实证 |
|---|---|
| 证据链可审计:HMAC 哈希链 + 重放校验器 | HMAC-SHA256 over `prev_hash\nseq\nevent_type\npayload`(`apps/lumen/internal/server/verify.go:38`);`RunVerify`/`RunVerifyEvidence` 三方比对+链校验(`verify.go:42,67,104-106`);compose `verifier` 服务一键跑 |
| 链断 UI 直接给评委看 | `/preview/evidence/broken` CHAIN BROKEN 预览(`apps/web/src/routes/IndexPage.jsx:61-62`) |
| AI 永不裁决出价(冻结边界) | AI 是 sidecar(`server.go:61` AuctioneerHooks→`apps/ai-sidecar/`);AI 挂了竞拍照常,前端降级文案「拍卖师暂离」(`LiveRoomRoute.jsx:346`);`make chaos-ai` 验证出价路径独立(`Makefile:190`) |
| 金额全链路字符串分:JS/Go/Lua 零精度损失 | `MAX_MONEY = 2^53-1`(`place_bid.lua:17-19`);Go 入口 canonicalAmount 守门(`ws.go:1545-1551`、`api.go:203`);前端 BigInt 比较;精度隐藏测试 `lua_t2_pdggk_hidden_money_precision_test.go` |
| 帧预算自适应动效降级 | 连续 30 帧 >22ms(~45fps)→ `body.surface-calm` 关闭装饰动效(`apps/web/src/lib/perf/frameBudget.js`、`main.jsx:10`、`styles.css:444+`) |
| 混沌演练制度化(dev-only fail-closed) | `LUMEN_CHAOS_DISABLE_TIMER=1` 仅 APP_ENV=dev 允许,非 dev 启动即拒(`server.go:104-115`);`make chaos-timer` 等五相演练(`Makefile:187-364`、`docs/t9-chaos.md`) |

## 5. 答辩演示动作清单(每条 ≤30s)

| # | 动作 | 预期画面 | 入口 |
|---|---|---|---|
| 1 | 幂等双发:同 clientBidId 连发两次 | 第二次回放原 seq,房间无第二次广播 | `npm run smoke:multigw` dup 阶段(脚本化断言);手动可 wscat 双发同帧 |
| 2 | 断网 5 秒重连 | ROOM_JOIN(lastSeq) 补帧,seq 连续无空洞 | `npm run smoke:catchup`;手机演示开飞行模式 5s + PullToResync |
| 3 | 双网关两手机互拍 | :8080 出价,:8081 同帧跳价,同 seq | `--profile multigw up` + 两手机进同房(`docs/demo/multi-gateway-demo.md`) |
| 4 | 证据链断裂预览 | CHAIN BROKEN 红色态 vs CHAIN VERIFIED | 浏览器开 `/preview/evidence/broken` |
