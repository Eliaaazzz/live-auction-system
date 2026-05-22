# CLAUDE.md — Lumen Auction Project Policy

> Project-level guidance for Claude sessions opened in this repository.
> Treat this file as operating policy, not as a product specification.

## Project

Lumen Auction is the team implementation of the ByteDance Douyin E-commerce AI Full Stack challenge: a live auction system for known, single-item, high-value goods. The official challenge window is 2026-05-20 to 2026-06-10, with demos on 2026-06-11 to 2026-06-12. Internally, the V8 plan uses 2026-06-08 as the implementation freeze date; public coordination should speak to the 2026-06-10 official deadline.

## Collaboration Model

Claude should treat this repository as a source-grounded project workspace. For non-trivial edits, first identify the authoritative source, then make the smallest scoped change that preserves frozen V8 decisions and public documentation consistency.

### Review Workflow

1. Read the task-specific request and the named source artifacts.
2. Inspect the current files before writing.
3. Keep edits limited to the requested files and record verification commands.
4. Report a compact verdict with changed files, checks run, and residual risks.

### Anti-patterns

- Editing unrelated files while fixing a documentation or contract issue.
- Treating README-style summaries or old working notes as stronger than the PDF, GitHub issues, or reviewed public docs.
- Publishing, pushing, or changing remotes without explicit confirmation.
- Editing `docs/team-memory/decisions.md`, `docs/team-memory/stakeholders.md`, or local workflow templates without an explicit user request.

## Sources Of Truth

Primary sources are, in order:

1. The original challenge PDF in `docs/spec/抖音电商AI全栈-直播竞拍全栈系统-宣讲版.pdf`.
2. GitHub Issue #1 Plan V8 for delivery scope, frozen engineering boundaries, and numeric acceptance thresholds.
3. GitHub Issue #2 Architecture RFC v1 for the reviewed Edge/Core/Data architecture, state machine, Redis/MySQL design, WebSocket protocol, and implementation cautions.
4. GitHub Issues #3-#9 for sub-contracts covering WebSocket, rules, Lua/Stream, AI, evidence, load testing, and demo fallback.
5. Public docs under `docs/`, once written and reviewed.

README-style summaries are leads only. Verify against the actual source file or issue before making claims.

## No-Touch Zones

- Do not read or echo `.env*`, credentials, API keys, tokens, cookies, or local secret notes.
- Do not edit `.git/`, generated caches, build output, or dependency directories.
- Do not modify `docs/team-memory/README.md`, `docs/team-memory/decisions.md`, or `docs/team-memory/stakeholders.md` unless explicitly asked.
- Do not change remotes, publish issues, send comments, or push branches without explicit confirmation.

## Hard Rules

- Preserve V8 decisions unless the user explicitly asks for a decision review. Do not reopen Redis Lua, Redis Stream, Timer Worker, AI-as-sidecar, Replay Verifier, AOF everysec, or video non-authoritative decisions casually.
- Keep AI outside bid adjudication. AI may draft facts and auctioneer copy, but sellers confirm facts and backend state controls accepted bids, winners, prices, and terminal states.
- Keep compliance framing tight: transparent single-item auction, no mystery box, no random card break, no authenticity guarantee, no real payment/logistics commitment.
- Preserve all numeric thresholds exactly when copying them: ack p95 < 80ms, broadcast p95 < 150ms, hammer p95 < 500ms, catchup 200 events < 1s, seq gap = 0, P0 500 connected + 50 active, Stretch 1k + 100, WS bufferedAmount 1MB/4MB, AOF everysec.
- When uncertain, write the uncertainty down instead of filling gaps with invented design.

## Confirmation Gates

Ask before destructive operations, remote publication, dependency additions, schema-breaking changes, deadline changes, or changes to frozen state machine / Redis key / WebSocket protocol contracts.

## Memory Scope

Public project truth belongs in `docs/`. Personal or private working notes belong only under `docs/team-memory/` and must not be treated as team policy.
