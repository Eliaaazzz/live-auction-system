# AI Usage Log

Draft public evidence path for PDGGK and Eliaaazzz review.

The challenge PDF assigns 15% to `AI使用与落地效果`: whether AI tools are used reasonably, whether the tool choice fits the project, whether the workflow is standardized and traceable, and whether AI code contribution is reasonable. This log records both development AI use and runtime AI/model-call use so the final materials can show process evidence, not only product UI features.

This template does not mandate a single tool stack. Each teammate records the tools they actually used, with public-safe summaries instead of raw prompts or secrets. Never log API keys, `.env` values, request headers, provider-console screenshots, private teammate notes, or screenshots containing credentials.

Humans own architecture, auction correctness, security, state transitions, frozen rules, winner decisions, and final review. Higher AI-generated volume is not treated as better. Contribution notes should explain what AI helped draft, what was changed or rejected, and how the result was verified.

Create one file per meaningful entry:

`docs/ai-usage/<YYYY-MM-DD>-<scenario-slug>.md`

## Log Template

| 日期 | 工具 | 场景（前后端/AI模型调用/审查/文档） | Prompt 摘要 | Output 摘要 | Human Reviewed (Y/N + 由谁) | Decision（accepted/modified/rejected） | Artifact Ref | Verification | Contribution Note |
|---|---|---|---|---|---|---|---|---|---|

## EXAMPLE

Hypothetical entry only; replace with real team work when used.

| 日期 | 工具 | 场景（前后端/AI模型调用/审查/文档） | Prompt 摘要 | Output 摘要 | Human Reviewed (Y/N + 由谁) | Decision（accepted/modified/rejected） | Artifact Ref | Verification | Contribution Note |
|---|---|---|---|---|---|---|---|---|---|
| 2026-05-22 | coding assistant | 审查/文档 | Asked for public-safe fields to prove AI workflow traceability. | Suggested adding human review, decision outcome, verification, and contribution notes. | Y - Eliaaazzz | modified | `docs/ai-usage/README.md` | Checked against PDF AI scoring text and `docs/decisions.md` Q7. | Documentation scaffold only; no core code contribution. |
