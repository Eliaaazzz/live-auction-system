# T6 Buyer Room — Round-2 Prototype (v2)

独立 prototype，配合 PR #49 的 round-2 review 使用。**不参与 build，不影响 `apps/web/` 主应用。**

## 看效果

无需 install / build，直接浏览器打开：

```bash
# 任意静态服务器都行（file:// 也能跑，但 Babel-standalone 远程 fetch JSX 受 CORS 限制时换 http）
cd apps/web/prototypes/v2
python -m http.server 5174
# 打开 http://localhost:5174/
```

或者用 VS Code 的 Live Server / `npx serve .` 都可以。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | bootstrap，design tokens (Space Grotesk + 深底 + 熔岩橙)，引入 React 18 + Babel-standalone via unpkg |
| `app.jsx` | 房间 App — state 机、bot scheduler、particle dispatcher、demoState 切换 |
| `components.jsx` | UI 元件 — PriceCore / TopThree / BidButtons / LiveFeed / TerminalOverlay 等 |
| `effects.jsx` | 运动元件 — `useRollingNumber` / `CountdownRing` / `HeatMeter` / `ConfettiBurst` / particle layer |
| `tweaks-panel.jsx` | 复用的 Tweaks 面板 shell |

## Tweaks 面板（右上角）

直接在浏览器里切换演示形态，方便 review 时对比：

- **quickBidMode**: `percent` (+1% / +5% / +10% / MAX) ｜ `absolute` ｜ `increment`
- **topN**: `podium3` (推荐) ｜ `list5` ｜ `leader`
- **particles**: `off` / `subtle` / `full`
- **audience**: `buyer` / `seller`
- **demoState**: `live` / `extending` / `sold` / `no-bid` / `cancelled`

## Round-2 三条主要意见（对 PR #49 buyer room）

1. **砍掉 Leaderboard 整段列表，换 Top-3 podium。** 前 3 才有视觉张力，更深的名次只会让画面变 noisy。
2. **把 `<input type="number">` 换成 quick-bid chips: +1% / +5% / +10% / MAX**，custom amount 收进 bottom drawer。直播时没人会准确输数字。
3. **大幅加运动 / 反馈：** rolling 替换成 price flash + glow、last-10s ring 转红、+10s 反狙击 pill swoop、SOLD 撒花 + screen shake、heat meter 显示 bids/s。

## 硬约束（没动）

- money-as-string
- backend-authoritative — 最终价以服务端 seq 为准
- seq 单调（"BACKEND IS AUTHORITATIVE" 字样留在 room 底部 footer）
- AI 仅展示，不进出价路径
