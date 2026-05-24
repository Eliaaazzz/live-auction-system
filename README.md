# Lumen Auction：直播实时竞拍系统

Lumen Auction 是字节跳动 Douyin E-commerce AI Full Stack 挑战赛项目，面向透明的已知单品直播竞拍闭环。

卖家发布商品，确认 AI 辅助生成的商品事实，冻结竞拍规则；买家进入房间后通过 WebSocket 长连接实时出价。后端以 Redis Lua 作为唯一出价裁决路径，用单调 `seq`、Redis Stream、MySQL 事实库和 Replay Verifier 生成可复盘证据链。Timer Worker 按后端状态落锤，视频和 AI 只提供展示与辅助文案，不作为价格、胜者或时间裁决来源。

P0 目标聚焦高并发出价、断线 catchup、状态机终态一致、证据卡和 500 connected + 50 active 的稳定压测证明。

## 关键词

- WebSocket 长连接
- Redis Lua
- Redis Stream
- Replay Verifier
- 状态机
- 高并发出价
