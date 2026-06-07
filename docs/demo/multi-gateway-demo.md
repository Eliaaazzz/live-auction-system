# 多网关房间路由演示运行手册(multigw)

> 目标:向评委证明「房间级 WebSocket 路由隔离」——网关无状态、房间事件走 Redis backbone、
> 跨网关实例 seq 完全一致。一笔经网关 A 裁决的出价,连在网关 B 上的客户端以**相同 seq**
> 收到广播;重复 clientBidId 重试只回放原 ack,不产生第二次广播。
>
> 原理:`apps/lumen/internal/server/server.go` 中 `--mode=all|gateway` 都会启动
> `hub.subscribe`(`apps/lumen/internal/server/ws.go`),每个网关实例订阅同一
> Redis Pub/Sub 唤醒 + Redis Stream 权威事件源,再扇出到本进程 `hub.rooms[auctionId]`
> 里的本地连接。出价裁决始终是同一份 Redis Lua(`apps/lumen/internal/lua/place_bid.lua`),
> 与客户端从哪个网关进来无关。

## 一、本地版(docker compose,5 分钟)

拓扑:

```
                         ┌────────────────┐
  phone A / WS A ──────► │ lumen   (:8080)│ --mode=all      ┐
                         └────────────────┘                  │  同一 Redis
                         ┌────────────────┐                  ├─ backbone
  phone B / WS B ──────► │ lumen-gw2(:8081)│ --mode=gateway  ┘  (redis:6379)
                         └────────────────┘
  浏览器(可选) ───────► gateway-lb(:8088) nginx least_conn → 上面两台
```

### 1. 启动

```bash
# 仓库根目录
docker compose -f infra/docker-compose.yml --profile multigw up -d --build
# 等 lumen / lumen-gw2 healthcheck 变绿(各自 wget /healthz)
docker compose -f infra/docker-compose.yml --profile multigw ps
```

### 2. 自动化冒烟(评委面前先跑这个)

```bash
cd apps/web && npm run smoke:multigw
```

脚本(`apps/web/scripts/smoke-multigw.mjs`)做的事:

1. 经 GW1(:8080) REST:卖家 dev-login → 建商品 → 建拍卖草稿 → freeze → start;
2. 买家 A 连 GW1 的 `/ws`,买家 B 连 GW2(:8081) 的 `/ws`,同房间 `ROOM_JOIN(lastSeq=0)`;
3. A 经 GW1 出一笔价 → 断言 **A、B 双方 3 秒内都收到 BID_ACCEPTED,seq 与 amountCents 完全一致**;
4. A 用**同一个 clientBidId** 再发一次 → 断言回放原 seq 的幂等 ack,且 B **没有**收到第二次广播(全程只铸了一个 seq)。

通过时输出 `✓ PASS — ... seq=N`,失败退出码非 0 并列出断言。
环境变量 `GW1` / `GW2` 可改指向(默认 `http://localhost:8080` / `http://localhost:8081`)。

> 说明:本手册编写时脚本已通过 `node --check` 语法校验、compose 文件已通过
> `docker compose --profile multigw config -q` 校验;端到端跑通需要本机起容器
> (`docker compose ... --profile multigw up -d --build`,即 `make up` 的 multigw 版)。

### 3. 两台手机互动版(最直观)

1. 查出本机局域网 IP(Windows:`ipconfig` 看 IPv4),记为 `<host>`;
2. 手机 A 浏览器开 `http://<host>:8080`,手机 B 开 `http://<host>:8081`
   (两个端口是**两个不同的网关进程**,同一镜像内置同一份 SPA);
3. 两台手机进**同一个**拍卖房间互相出价:任一台出价,另一台立即看到价格跳动、
   排行榜更新、倒计时同步——这就是跨网关房间扇出;
4. 也可以两台都开 `http://<host>:8088`(nginx LB,`least_conn`),长连接被分散到
   两台网关上,效果一致——证明客户端根本不需要关心落在哪台网关。

## 二、Tier-1 云上版(私网 LB + 双 gateway worker)

> 既有环境与预检/监控工具见 `docs/runbooks/beijing-tier1-10k-demo.md`
> (随 PR #232 / 分支 `feat/beijing-tier1-10k-preflight` 交付:wsload 预检 +
> wsdash 容量面板 + Tier-1 runbook)。Tier-1 = VPC 内 worker + 私网 LB,
> 规避 issue #231 公网自拨 NAT hairpin。

1. 两台 ECS worker 各跑一个网关:`lumen serve --mode=gateway`,环境变量指向
   同一 Redis/MySQL(`REDIS_ADDR`/`MYSQL_DSN`),`JWT_SECRET` 必须一致
   (token 在任意网关有效,这正是无状态的前提);另有一台跑 `--mode=timer` +
   `--mode=pg-writer`(或一台 `--mode=all`)承担落槌与落库;
2. 私网 LB(七层需开 WebSocket 升级透传;四层 TCP 直通最稳)把 80 端口
   分发到两台网关的 `:8080`;本仓库 `infra/nginx/gateway-lb.conf` 即可直接
   作为自建 nginx LB 配置(`least_conn` + Upgrade 头 + 300s read timeout);
3. 验证:`GW1=http://<worker1>:8080 GW2=http://<worker2>:8080 npm run smoke:multigw`
   ——绕过 LB 直打两台网关,断言跨实例 seq 一致;再把两个变量都指到 LB
   (`GW1=http://<lb> GW2=http://<lb> npm run smoke:multigw`)跑一遍:两条 WS
   被 `least_conn` 摊到不同网关,既验升级头透传又复验 seq 一致;
4. 压测口径沿用 §4.2:ack p95 < 80ms、broadcast p95 < 150ms、seqGap = 0,
   监控用 `tools/loadtest/wsdash.py` 盯 `/metrics`。

## 三、讲解话术(评委演示 30 秒版)

> 「两个端口是**两个独立的网关进程**——一个 `--mode=all`,一个纯 `--mode=gateway`。
> 网关完全无状态:房间成员只是本进程内存里的 `hub.rooms[auctionId]` 注册表,
> 出价裁决在 Redis Lua 里原子完成,事件写进 Redis Stream 再扇出给**每一个**订阅的网关。
> 大家看这两台手机:这台连 8080,那台连 8081,我在这边出价——那边同帧跳价,
> 两边收到的是**同一个 seq**。换句话说,加网关 = 加机器,不改一行代码;
> 我们已经实测单网关 1 万并发连接全绿,天花板约 1.5 万连接,
> 再往上就是水平加网关——架构是为它准备好的(见 docs/reports/ 的 Tier-2 压测报告)。」

落槌点(judges' criterion 对照):

| 评委关注 | 演示动作 | 看什么 |
|---|---|---|
| 房间级路由隔离 | 双手机不同端口同房间互拍 | 双端同步跳价 |
| 跨网关一致性 | `npm run smoke:multigw` | `same seq` PASS 行 |
| 出价幂等 | 同脚本 dup 阶段 | `replayed original ack, no new seq` |
| 水平扩展性 | 指 compose 文件 | 加一段 service 就是加一台网关 |

## 四、Troubleshooting

| 症状 | 原因 | 处理 |
|---|---|---|
| `8081`/`8088` 端口占用,compose 起不来 | 本机已有进程占端口 | `netstat -ano \| findstr :8081` 找到 PID 停掉;或改 compose 里宿主侧端口映射(容器侧勿动) |
| `lumen-gw2` 一直 unhealthy | 依赖未就绪(它 depends_on lumen healthy)或镜像没构建 | `docker compose ... logs lumen-gw2`;确认 `--build` 带上;`wget /healthz` 在容器内自检 |
| smoke 报 `dev-login 403` | `ENABLE_DEV_LOGIN` 没生效(非 dev 环境) | 确认 compose 内 `APP_ENV: dev` + `ENABLE_DEV_LOGIN: "true"`(两台网关都要) |
| B 收不到广播,A 正常 | 两网关没连同一个 Redis | 核对两台的 `REDIS_ADDR` 都是 `redis:6379`;`docker compose ... exec redis redis-cli client list` 应看到两个订阅者 |
| 经 LB(:8088) WS 握手 400/连接秒断 | 升级头没透传 | 必须 `proxy_http_version 1.1` + `Upgrade $http_upgrade` + `Connection "upgrade"`(见 `infra/nginx/gateway-lb.conf`);云上七层 LB 要显式开 WebSocket |
| 经 LB 空闲约几分钟后断线 | 代理 read timeout 过短 | 服务端 PING 周期 54s(`pingPeriod`,`apps/lumen/internal/server/ws.go`),LB read timeout ≥ 60s,本配置已设 300s |
| token 在另一台网关 401 | 两台 `JWT_SECRET` 不一致 | 两个网关必须共享同一 `JWT_SECRET`(本地均为 `change-me-local-only`) |
| 手机打不开页面 | 防火墙挡了 8080/8081/8088 入站 | Windows 防火墙放行,或手机与电脑确认同一局域网段 |
