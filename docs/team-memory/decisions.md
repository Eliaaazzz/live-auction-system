# Decisions Log

> 时间线 + 已拍板项 + 待拍板项。新决策追加到顶部。
> 仅 PDGGK 视角；团队级共识落到 `docs/charter.md` / GitHub Issue。

---

## 2026-05-21 — Sprint 0 Day 1 (PDGGK session #2)

### 已拍板 / 已收口

- **Eliaaazzz 已在 #11 全面回复 Q1-Q9**：对外 2026-06-10，内部 2026-06-08；项目名统一为 `Lumen Auction：直播实时竞拍系统`；Eliaaazzz 认 A / Realtime Engineer；P0 保 Replay Verifier + hash chain + 500/50 + 5 项故障演练短录像，1000/100 为 Stretch。
- **数据库收口为 MySQL 8 + Redis**：SQL DB 不进竞拍热路径；Redis Lua 扛出价、排行、裁决、幂等和 seq；MySQL 作为事实库、订单库、审计库，通过 Redis Stream 幂等回放。
- **4 项唯一事实源**：DB 统一 MySQL 8；状态机以 `docs/state-machine.md` 为唯一契约；#3-#9 当设计参考，不当活跃待办；P0 / Stretch 按 #11 口径收口。
- **RACI 初版**：A = @Eliaaazzz；B/C 仍 TBD。DB schema 切分为 A 拥有事件链路表（`auction_events` / `bids` / Stream -> MySQL replay），B 拥有业务向表（`products` / `auctions` / `auction_rules` / `orders` / `users`）。

### 仍待确认 / 跟进

- 等第三人 self-introduce：技术背景、每天可用时间、B/C 偏好、能否负责部署 / 压测 / 录屏 / 文档之一。
- 等用户 confirm Q5/Q6/Q7：PDGGK 可投入时间、第三人身份/方向、Doubao APIKey 私下管理方式。
- `proto/` 目录待建：Eliaaazzz 在 #11 假设已有 `proto/`，但当前仓库实际不存在；A 线 owner 后续建立 `proto/ws-envelope.md`、`proto/redis-keys.md`、`proto/openapi.yaml`、`proto/ai-events.md`、`proto/db-schema.md` 后 B/C 引用。

---

## 2026-05-20 — 项目启动（PDGGK + Claude session #1）

### 已拍板

- **AI 工作流**：PDGGK 采用 Codex-PM 模式（Claude = PM，Codex = worker，Codex subagent 并行）。**不强加给队友**——每人保留自己的 AI 使用方式，这是三人多样性的价值来源。
- **Memory 共享**：Claude / Codex 跨会话上下文落到仓库内 `docs/team-memory/`，不用 Claude 私有 `~/.claude/projects/.../memory/`（Codex 看不到）。
- **内外分离**：所有"对外"主线 docs（`charter.md` / `architecture.md` / `roadmap.md` / `diagrams/` 等）零 Codex-PM 痕迹。私有方法 note 放 `docs/team-memory/`，commit 到 git 但标"私有"。
- **继承 Eliaaazzz 已有架构**：GitHub Issue #1 Plan V8 + #2 RFC v1（reviewed）= 当前架构 source of truth。Go / MySQL / Redis Lua + Stream / WebSocket 房间隔离 / Timer Worker / Replay Verifier 已锁定，不重启讨论。
- **保留 V5 review 合规底色**：透明单品竞拍 / no mystery box / no random card break / AI 显式标识 / 真人最终背书 / LLM 受 schema 约束。已被 V8 §11 采纳。
- **可视化策略**：Mermaid 主力（GitHub 原生渲染）+ PlantUML 复杂时序补充；PPT/PDF 最后一周用 pandoc 或线上 LLM 出。本地工具齐：plantuml / mmdc / pandoc / dot 全装。
- **本日执行路径**：B → A → C。先建 team-memory + CLAUDE/AGENTS 填实 → 画 mermaid 全景图 → 启动 Codex 综合 9 issues + PDF → docs/。
- **不冲速度**：用户明确"做就做最高质量"，节奏由质量驱动而非 deadline。

### 待拍板（等 PDGGK 或 Eliaaazzz 回）

| # | 项 | 备选 | 影响 |
|---|---|---|---|
| Q1 | 死线 | V8 写 2026-06-08 / PDF + 口头 2026-06-10 | 对外用哪个？相差 2 天=Sprint 4 的缓冲带 |
| Q2 | 项目名 | Lumen Auction (V8) / 实时竞拍大师 (RFC v1) / 直播竞拍系统 (README) | 答辩材料、PPT、GitHub repo 命名要统一 |
| Q3 | A/B/C 认领 | A=Realtime / B=Product / C=Infra+AI+QA | Eliaaazzz 大概率 A；PDGGK 倾向？第三人是谁？ |
| Q4 | P0 亮点取舍 | V8 强调 Replay Verifier + hash chain（25% 技术深度） vs PDF 评分可能更偏 1000+ 并发实测 | 二选一聚焦 or 都做 |
| Q5 | PDGGK 时间投入 | 实际可用小时/天 | 决定能否独立 own 一条主线 |
| Q6 | 第三人是谁 | — | 决定 A/B/C 最后一槽的人选 |
| Q7 | AI 帐号管理 | Doubao APIKey 三人共用（PDF 已给）| 要建一份私密 secrets note？|
| Q8 | 演示压测目标 | 500/50 P0 only / 1k/100 Stretch 也做 | 决定 Sprint 4 时间分配 |
| Q9 | Sprint 4 演示视频形式 | 公网部署 + 本地 fallback / 仅本地录屏 | 决定 Infra 复杂度 |

### Open observations（不入主线决策）

- 仓库还几乎是空的（只有 PDF + 模板 + Plan V8 in GitHub Issue），但 Eliaaazzz 的 RFC 工作非常成熟，落地代价不小。
- PDGGK 在 5.15 已经 review 过 V4 并被采纳到 V5/V7/V8，说明三人沟通节奏不错。
- 字节导师 5.21 分配后可能影响某些细节，但 P0 架构稳定，无需等待。
