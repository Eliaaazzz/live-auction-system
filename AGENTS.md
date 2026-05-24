# AGENTS.md — Lumen Auction

> Read by Codex agents working in this repository. Combine with task-specific user instructions and the current source tree.

## Project Identity

Lumen Auction is a live auction full-stack system for the ByteDance Douyin E-commerce AI Full Stack challenge. The product target is a transparent known-item auction flow: seller publishes an item, confirms AI-drafted facts, freezes rules, runs real-time bidding, closes by backend state, and produces order/evidence material for the demo.

## Codex Role In This Project

Codex is the primary executor for source-grounded implementation, refactor, audit, and documentation tasks in this repository.

Stay strictly within the task spec. Read the named sources first, inspect the current tree, make only scoped edits, and consolidate the result into a compact report with verdict, changed files, verification commands, and residual risks. If you spot an unrelated issue, note it under residual risks instead of fixing it.

## Verified Directories

Verified on 2026-05-20 by running `pwd`, `git rev-parse --show-toplevel`, `find . -maxdepth 2 -mindepth 1`, and `rg --files`.

| Path | Purpose | Verified date |
|---|---|---|
| `docs/` | Challenge PDF, public design docs, and diagrams | 2026-05-20 |
| `docs/diagrams/` | Mermaid architecture and flow diagrams | 2026-05-20 |
| `CLAUDE.md` | Claude-facing project policy | 2026-05-20 |
| `AGENTS.md` | Codex-facing project policy | 2026-05-20 |

## No-Touch Zones

- `.env*`, credentials, API keys, tokens, cookies, or secrets: never read, print, or commit.
- `.git/`, generated caches, dependency directories, build output: never edit directly.
- Project lock files: do not modify.
- `docs/team-memory/README.md`, `docs/team-memory/decisions.md`, `docs/team-memory/stakeholders.md`: do not modify unless explicitly requested.

## Hard Rules

### Source-Grounded

Every project claim must trace to a concrete source: the PDF, GitHub issue snapshots, existing docs, or a command result. README text and prior memory are hints, not proof. If sources conflict, name the conflict and preserve the stronger or newer frozen decision instead of inventing a compromise.

### Frozen Decisions

Preserve Plan V8 and reviewed RFC decisions: Redis Lua is the bid adjudicator, Redis Stream is the durable event log, Timer Worker closes expired auctions, AI is a sidecar, Replay Verifier is P0, video is non-authoritative, and AOF everysec is not a financial-grade guarantee.

### Protected Blocks

Do not delete protected documentation blocks wholesale. Tighten or fold them if needed:

- `[!tip]`, `[!warning]`, `[!example]`, `[!quote]`, `[!info]`, `[!abstract]`, `[!question]`, `[!note]`
- `<details><summary>...</summary>...</details>`

### Output Discipline

- Edit only files named by the task.
- No drive-by refactoring.
- Keep reports compact: verdict, changed files, verification, residual risks.
- Keep public docs free of private workflow details.

## Concurrency

Read-only exploration may run in parallel. Only one writer should edit the main checkout at a time. Parallel implementation attempts should use separate worktrees and merge intentionally.
