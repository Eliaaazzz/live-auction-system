# Team Memory — 内部工作笔记（PDGGK 私有）

> **此目录是 PDGGK 在本项目中的个人工作记忆**。
> 队友（Eliaaazzz 等）不必读、不必遵循里面的方法学。
> 仍 commit 到 git 是为了让 PDGGK 的 Claude / Codex 跨会话保留上下文。
> 每个团队成员都有自己的 AI 工作流，这是多样性的一部分，不强加给团队。

## 内容索引

| 文件 | 说明 | 对外可见? |
|---|---|---|
| `codex-pm-workflow.md` | PDGGK 用 Claude+Codex 协作的具体流程 | 仅本人 |
| `decisions.md` | 决策时间线 / 拍板记录 / 待拍板项 | 仅本人 |
| `stakeholders.md` | 团队成员、角色、偏好（含 PDGGK 自身） | 仅本人 |
| `context.md` | 比赛背景、约束、目标的内部理解 | 仅本人 |
| `conventions.md` | 沟通 / 写作 / 命名约定 | 仅本人 |
| `gaps.md` | V8 与 PDF 差异、未对齐项跟踪 | 仅本人 |

## 设计原则

1. **内外分离**：主线 `docs/charter.md`、`docs/architecture.md`、`docs/roadmap.md` 等是团队共识 doc，零私有方法痕迹。`team-memory/` 是 PDGGK 个人方法的存档。
2. **不影响他人**：CLAUDE.md / AGENTS.md 是项目级通用规则，不强制要求队友采用 PDGGK 的工作流。
3. **可被 Codex 读取**：本目录在 git 内，PDGGK 的 Codex 会读，作为跨会话上下文。
4. **可丢弃**：如果方法学过时，本目录可整体重写或删除，不影响主线代码与文档。
