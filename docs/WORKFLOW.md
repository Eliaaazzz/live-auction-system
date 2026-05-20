# Team Workflow

## Sprint cadence

- **Sprint 1**: Day 1-5 — contracts + skeleton
- **Sprint 2**: Day 6-10 — core auction loop
- **Sprint 3**: Day 11-15 — multi-instance + catchup + AI sidecar
- **Sprint 4**: Day 16-20 — reliability + demo

End-of-sprint (Day 5/10/15/20): 30-min retro. We **never** move the deadline, only scope.

## Daily

- **10:00** standup in group chat (3 lines: 昨天 / 今天 / 卡点)
- **22:00** end-of-day update (same format)
- **>2h blocker** → ping team for pair session immediately

## Branches

- `main` is protected. All changes via PR with ≥1 approval.
- Feature branches: `feat/<area>-<short-desc>` (e.g., `feat/realtime-bid-lua`)
- Bug fixes: `fix/<area>-<short-desc>`
- Chores: `chore/<area>-<short-desc>`
- Keep PRs < 400 lines if possible. Bigger PRs get pair-review.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `perf:`, `ci:`.

```
feat(realtime): atomic bid lua + ranking ZSet
fix(web): seq dedupe on reconnect
```

**Never** add `Co-Authored-By: Claude` lines.

## Contracts (proto/)

These four files are the contract surface between A/B/C. Edit them like API contracts:

- `proto/ws-envelope.md` — owner @A
- `proto/openapi.yaml` — owner @B
- `proto/ai-events.md` — owner @C
- `proto/redis-keys.md` — owner @A

**Day 1-2**: write drafts. **End of Day 2 (2026-05-20)**: freeze v1.
Breaking changes after freeze → owner + ≥1 approve.

## GitHub Projects board (Kanban)

Columns: `Backlog → Ready → In Progress → Review → Done`

Required on each issue:
- Sprint label (`sprint-1`..`sprint-4`)
- Area label (`area:realtime` / `area:product` / `area:ai`)
- Acceptance criteria in body ("how do we know this is done?")
- Estimate in hours (optional but helpful)

## Code review

- Use the **everything-claude-code** review skills locally before pushing if helpful.
- PRs touching `proto/`, `bid.lua`, or state machine require the owner to approve, not just a teammate.
- Approve only after running the change locally for at least the happy path.

## Demo days

- **Day 5**: dummy bid round-trip; contracts frozen.
- **Day 10**: 50-user complete auction; no seq gaps; evidence card.
- **Day 15**: 500 connected viewers + 50 active bidders; catchup works.
- **Day 20**: 3-minute demo video + public deploy + fallback Docker.

## Local dev

```
docker compose up         # postgres + redis + 3 apps
# Web: http://localhost:5173
# Realtime healthz: http://localhost:8080/api/healthz
# AI healthz: http://localhost:8000/v1/healthz
```

Each app can also run standalone (see each app's README).

## Troubleshooting

- **Redis Stream missing events** → check Lua script bumped seq AND XADD in same call.
- **WebSocket drops messages** → check backpressure queue settings in `apps/realtime/internal/ws`.
- **PG out of sync with Redis** → consumer group offset; replay `auction:{aid}:events`.
