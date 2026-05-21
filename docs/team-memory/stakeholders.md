# Stakeholders

> 谁是谁、关心什么、AI 偏好。仅 PDGGK 视角；不发给团队。

---

## 团队 3 人

### PDGGK（用户本人）

- **GitHub**: PDGGK（gh 已登录，token scopes: gist/read:org/repo/workflow）
- **Git author**: ffccites / dzh1436286758@gmail.com
- **角色**: 项目方向 + 合规 reviewer。V5 review 的 commenter（建议"保留拍卖主线 + AI co-host + 不做盲盒"，被 Eliaaazzz 采纳到 V7 / V8）
- **时间投入**: 有限。本项目只是众多项目之一。**不当主导者**，但是关键决策点的 audit 角色
- **AI 工具偏好**: 
  - Claude Code 额度紧 → 用 Codex-PM 流程节流，Claude 调度，Codex 重活
  - Doubao-Seed-2.0-lite（赛题方提供，团队共用 APIKey）
- **倾向 A/B/C**: 待定。考虑 B（Product UI / 演示氛围 / 答辩材料）或 C（Infra+AI+QA / 压测 / 故障演练）；A=Realtime 主力大概率是 Eliaaazzz
- **沟通载体**: GitHub Issues / PR / 仓库内 docs commit（不开私聊群）

### Eliaaazzz（主导者 / 架构师）

- **GitHub**: Eliaaazzz
- **角色**: RFC v2 / Plan V8 主写手 + 架构思想深 + 已在 GitHub 贡献 9 个 issue（V8 / RFC v1 / 7 个 sub-RFC）
- **观察到的工作风格**:
  - 高密度迭代（V4 → V5 → V6 → V7 → V8 在 5 天内完成）
  - 强调数字化验收（ack p95、broadcast p95、seq gap = 0 等硬指标）
  - 强调"不承诺金融级"、"AI 旁路不进裁决"等清晰边界
  - 在 RFC v1 中做 correctness review，主动指出原架构 7 处 hole
- **AI 偏好**: 未知。**不干涉**——保留团队 AI 工具多样性
- **倾向 A/B/C**: 大概率 A=Realtime Core Owner（架构掌舵 + Lua 脚本 + 状态机 + 出价 / Timer Worker / Replay Verifier 所有者）
- **沟通**: GitHub Issues（已贡献 9 个 issue + 在自己的 issue 内自评 review）

### 第三人（待 PDGGK 补充）

- **未确定**：身份 / 技术栈背景 / AI 偏好 / 时间投入
- **倾向 A/B/C**：A/B/C 余下槽位
- **行动**：PDGGK 在下一轮 session 补充信息

---

## AI 工具栈（PDGGK 私有）

| 工具 | 角色 | 注 |
|---|---|---|
| **Claude Opus 4.7 1M** | PM、战略、审查、对话 | 1M 上下文，额度紧 |
| **Codex CLI 0.130.0 (GPT-5.5 xhigh)** | 主力 worker | 通过 `codex-supervisor` wrapper 调用 |
| **Codex subagent** | 并行视角 | Codex 内部 spawn 3-5 个，由 task.md 控制 |
| **Doubao-Seed-2.0-lite** | 业务 AI（VLM facts、LLM 拍卖师文案）| 团队公用 APIKey（PDF 已给）|
| **本地工具** | 可视化 | plantuml ✅ / mmdc ✅ / pandoc ✅ / dot ✅ / marp ❌ / magick ❌ |

---

## 比赛侧

- **赛事**: 字节跳动 2026 抖音电商 AI 全栈训练营
- **赛题**: 「实时竞拍大师」直播竞拍全栈系统设计与实现
- **关键节点**:
  - 2026-05-20 课题讲解（已完成）
  - 2026-05-21 导师分配
  - 2026-05-20 → 06-10 课题挑战（20 天）
  - 2026-06-11 ~ 06-12 项目演示
  - 颁奖 & 面聊
  - 成功入职
- **奖励**:
  - 卓越项目 1 队：2 万现金 + 直通 offer
  - 优秀项目 20 队：直通面试
  - 完成项目：参与证明 + 纪念品
- **导师团队**: Changyang Liu / Xin Gao / Haojie Guo / Jin Cai / Yang Yang / Lei Wang / Qiangsheng Wu
- **导师提示原话**: "不必追求全部满分，选择你最有兴趣的方向深入打磨，把一个亮点做到极致" —— 但目标是第一名，所以闭环+亮点+材料三者都不能缺
