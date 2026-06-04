# 火山直播视频推拉流 Runbook (Volcengine Live)

> **Status:** stretch / 加分项 (FAQ §4, optional). The 直播间 already simulates the feed
> (CSS sheen, styles.css #110); this makes it a **real** RTMP→HLS stream.
> 🔒 **Video is NON-authoritative** (CLAUDE.md frozen): display-only, never gates bids/state.
> If no stream is configured/live, the room silently falls back to the sim sheen — the
> ms-level auction is unaffected (HLS latency ~several seconds is fine).
> ⚠️ **火山直播 强依赖域名** — B0 is the critical path (实名审核 1–3 days). Start it FIRST.

## B0 — 域名 (队长, 关键路径, 今天就办)
国内直播推拉流平台需校验域名归属 + CNAME 接入 + 鉴权调度，**必须有域名**。
1. 注册 (火山引擎域名服务 or 现有): 查可注册 `https://www.volcengine.com/product/domain-service/search`；`.top/.xyz` 便宜，`.com/.cn` 体面。
2. 填注册人 + **实名模板** → 审核 (1 工作日，慢则 2–3 天)。**提前建好实名模板**。
3. 规划 2 个子域: `push.<domain>` (推流) + `play.<domain>` (播放)。
> ⏳ 审核期间可并行做 Part A 云部署 (不需域名)。

## B1–B5 — 火山引擎视频直播 (控制台)
路径: 产品与服务 → 视频服务 → 视频直播。官方动线: 开通服务 → 添加加速域名 → 配置 CNAME → 启用 HTTPS → 配置增值服务 → 生成推/拉流地址 → 推流 → 拉流。
- **B1 开通服务**。
- **B2 添加加速域名**: 加 `push.<domain>` (推流类型) + `play.<domain>` (播放类型)。
- **B3 配置 CNAME**: 到域名 DNS，把 push/play 子域 CNAME 到火山给出的目标 → 等生效 (30min–2h)。
- **B4 启用 HTTPS** (play 域，https 播放) + **配置增值服务** (确保 **HLS** + **HTTP-FLV** 输出开启；按需转码/录制)。
- **B5 地址生成器**: `AppName=live`，`StreamName=<auctionId>`，设过期时间 → 得:
  - **推流** (卖家/OBS): `rtmp://push.<domain>/live/<auctionId>?<sign>`
  - **拉流** (观众): HLS `https://play.<domain>/live/<auctionId>.m3u8` (+ HTTP-FLV `.flv`)
  - 记下 **鉴权 SignKey** (主/备 key) — 后端按它签 URL。

## B6 — 后端按拍卖铸 URL (env 配置)
后端把每个拍卖的 push/play URL 作为 `RoomSnapshotRules` 的**加法字段**下发 (同 `reserveCents` #60 模式；代码见 video-feature PR)。`StreamName = auctionId` (确定性，无需额外建流)。在 `infra/.env.prod` 配:
```bash
VOLCENGINE_LIVE_PUSH_DOMAIN=push.<domain>
VOLCENGINE_LIVE_PLAY_DOMAIN=play.<domain>
VOLCENGINE_LIVE_SIGN_KEY=<火山地址生成器的 SignKey>
```
重启 lumen 后:
- play URL (HLS) 自动进 `ROOM_SNAPSHOT.rules.livePlayUrl` → 前端播放。
- push URL (签名) 在 Admin 端「开拍」时展示给**卖家**贴进 OBS。
- 三个 env 任一为空 → `livePlayUrl` 不下发 → 直播间退回 sim sheen (demo 不硬依赖推流)。

## B7 — 卖家推流 (OBS Studio)
1. 装 OBS (`https://obsproject.com/`)。
2. 设置 → 直播 → 服务「自定义」:
   - **服务器**: `rtmp://push.<domain>/live`
   - **串流密钥**: `<auctionId>?<sign>` (Admin 端复制)。
3. 采集 摄像头/画面 → 「开始推流」。(FFmpeg 等价: `ffmpeg -re -i <src> -c copy -f flv "rtmp://push.<domain>/live/<auctionId>?<sign>"`。)

## B8 — 观众拉流 (前端 hls.js)
渲染链路已就绪 (`mobile.jsx` 的 `<video src={videoUrl}>`)，video-feature PR 加: `store/auction.js` 取 snapshot 的 `livePlayUrl` → `LiveRoomRoute.jsx` 传 `videoUrl` → `mobile.jsx` 用 **hls.js** 挂 `.m3u8` (Safari/iOS 原生播放；Chrome/Firefox/Edge 需 hls.js)。`hls.js` 加入 `apps/web/package.json`。FLV 低延迟可选 (flv.js)。

## B9 — 全链路验证
1. 后端配好 B6 env + 重启；建/开一个拍卖。
2. OBS 按 B7 推 `rtmp://push.<domain>/live/<auctionId>`。
3. 浏览器进该拍卖直播间 → 应看到**真实直播画面** (hls.js 播 `.m3u8`)。
4. 出价仍 ms 级 (视频非裁决，不受 HLS 数秒延迟影响)。
5. 关掉 OBS 推流 → 直播间退回 sim sheen，**不崩**。

## 验证清单
- ✅ CNAME 生效；地址生成器出 push/play URL；OBS 推流成功 (火山控制台「流管理」见在线流)。
- ✅ 直播间播真实流；`livePlayUrl` 为空时退回 sheen。
- ✅ 视频全程非裁决：杀流/高延迟都不影响出价/状态/seq。
- ✅ 低延迟 stretch (可选): HTTP-FLV (flv.js) 或 WebRTC 拉流地址，延迟从 HLS 数秒降到亚秒级。
