# CLAUDE.md — Lumen Auction Project Policy

> Project-level guidance for Claude sessions opened in this repository.
> Treat this file as operating policy, not as a product specification.

## Project

Lumen Auction is the team implementation of the ByteDance Douyin E-commerce AI Full Stack challenge: a live auction system for known, single-item, high-value goods. The official challenge window is 2026-05-20 to 2026-06-10, with demos on 2026-06-11 to 2026-06-12. Internally, the V8 plan uses 2026-06-08 as the implementation freeze date; public coordination should speak to the 2026-06-10 official deadline.

## Operating Model: Codex-First (MANDATORY)

This project runs on the **Codex-PM orchestration pattern** (`~/.claude/skills/codex-pm/SKILL.md`). Claude in this repo is **PM + final reviewer**, not the primary worker. Heavy lifting (multi-file edits, refactors, audits, RFC drafts, claim verification, paper deep-reads) goes to Codex via the `codex-supervisor` wrapper. The infrastructure is already validated — see `.codex-pm.lock`.

### Default workflow for any non-trivial task

1. Receive user task → write `handoff/runs/<task-name>/task.md` using a scaffold from `handoff/templates/` (`engineering-fix.md` for writes, `audit-only.md` for read-only reviews, `research-investigation.md` for exploration, `notes-pipeline.md` for data movement).
2. Spawn Codex in background — never block main context:

   ```bash
   nohup codex-supervisor handoff/runs/<task-name>/task.md \
       handoff/runs/<task-name>/report.md full \
       > handoff/runs/<task-name>/supervisor.log 2>&1 &
   ```

   Profile: `full` for workspace-write (xhigh), `readonly` for audits (xhigh), `priority` for time-sensitive runs.
3. While Codex runs, do something else in main context — talk to the user, plan the next task, read sources. Do NOT poll Codex.
4. When Codex finishes, read `report.md` + the diff. Audit for: correctness, scope creep (drive-by edits), source-grounding, adherence to V8 frozen decisions, V8 numeric thresholds.
5. Iterate via `handoff/runs/<task-name>/fix-1.md` if needed (max 5 rounds per task).
6. Surface a compact verdict to the user (changed files, verification commands, residual risks). Do not paste raw Codex output unless the user asks.

### Anti-patterns (do NOT do these)

- Writing code or RFC text directly in main context for anything multi-file or > 30 lines. Codex writes; Claude reviews.
- Spawning Claude subagents (`Task` tool) for code execution. Use `codex-supervisor` instead — Codex can spawn its own internal parallel subagents and consolidate one report.
- Skipping the task file and invoking `codex exec` inline with a long prompt. Always: file → supervisor. Tracked in `handoff/runs/<task-name>/`.
- Blocking on Codex. Always `nohup … &` and continue working. The cost of one wasted Codex run is far below the cost of stalling the session.
- Editing `docs/team-memory/decisions.md`, `docs/team-memory/stakeholders.md`, or `handoff/templates/*` without an explicit user request, even via Codex.

### When Claude writes directly (rare exceptions)

- Single-file edit ≤ 30 lines and clearly within scope (e.g., adding one line to CLAUDE.md, fixing one typo in a doc).
- `ls` / `grep` / `git status` checks and pure-question answers.
- User explicitly says "you do it directly" or "don't bother Codex for this".
- Codex unavailable (quota exhausted, outage, wrapper missing). Verify with `codex-supervisor --version` before assuming this.

### Lifecycle actions

If the Codex setup feels broken or stale, run the skill's lifecycle actions instead of patching by hand:

- `init` — fresh project setup.
- `doctor` — diagnose missing wrapper / drifted templates / stale lock.
- `migrate` — bring an older Codex-PM project up to the current manifest.

The current lock pins `wrapper_api = "1"`, `manifest_version = "2026-05-12"`, `handoff_mode = "run-directory"`, validated 2026-05-20.

## Sources Of Truth

Primary sources are, in order:

1. The original challenge PDF in `docs/spec-宣讲版.pdf`.
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
