# Component 16 — Dev Workflow

> **Path**: `docs/dev-log/`, `docs/dev-rules.md`, `.github/workflows/`, `Makefile`, branch conventions
> **Owner discipline**: leader proposes; **all-member approve** for branch convention, CI required-check set, or merge gate changes (V9 §6 + #15 §6).
> **Gates trunk**: T0a (CI gates online, dev-log template exists).
> **Cross-references**: [#15](../issues/15) Workflow v2, [#15 comment 4519333718](../issues/15#issuecomment-4519333718) (branch convention).

## Purpose

Encodes Workflow v2 (#15) into machine-enforceable rules: dev-log template, branch conventions, PR checklist, CI required checks, and the "diverse-review" merge gate. Everything in this doc is **process** — no Lua, no Lua-adjacent. But process correctness directly affects evaluator-visible signals (rubric 项目材料 10% + AI usage 15%).

## Dev-log template

File: `docs/dev-log/_template.md` (copy-paste source).

```markdown
---
date: YYYY-MM-DD
who: pdggk | elia | farizzz
trunk_step: T<N>  # or "off-trunk: <reason>"
related_prs: [#N, #M]
related_issues: [#A, #B]
---

## What changed
<one to three sentences>

## How
<short list of approach decisions; not a play-by-play>

## AI prompt summary
<one to two sentences on what you asked the AI and which tool>

## Decision points
<bullet list of choices and the rationale for each>

## Tests / evidence
<exact commands run; links to CI runs or screenshots>

## Open questions
<unresolved; pending team review or human ratify>

## Next step
<what you'll do in the next session>
```

**Author rules** (enforced by `.github/workflows/dev-log-lint.yml`):
- Front-matter must be valid YAML and include all five keys.
- `trunk_step` must match `T[0-9]+[ab]?` or `off-trunk: <reason>`.
- File name = `<date>-<who>.md` only; multiple entries per day per person = append.
- `AI prompt summary` must not contain raw API keys, tokens, or session cookies (regex check).
- No empty sections — every section requires at least one line.

## Dev-rules — the living rule set

File: `docs/dev-rules.md`. Author rules (Workflow v2 §6 sketch):

### §1 Naming
- Service: lowercase, single-word (e.g. `lumen`, `ai-sidecar`).
- Go package: lowercase, no underscores.
- TS module: kebab-case file, camelCase exports.
- WS message types: `SCREAMING_SNAKE` (per PR #13 ws-protocol.md).
- Metric names: `lumen_<component>_<metric>_<unit>` (e.g. `lumen_bidengine_lua_duration_seconds`).
- Event types in Stream: `SCREAMING_SNAKE` (mirrors WS).

### §2 Branches (per [#15 comment 4519333718](../issues/15#issuecomment-4519333718))
- `elia/T<N>-<slug>` for trunk-step PRs (e.g. `elia/T1-dummy-bid-roundtrip`).
- `elia/<topic>` for off-trunk leader work.
- `pdggk/<topic>` for PDGGK's reviewer-lens contributions.
- `farizzz/<topic>` for fariZzzz's infra/QA/AI/evidence work.
- Short-lived ≤ 2-3 days. 1 PR = 1 branch.
- `gh pr merge --delete-branch` after merge. No forever personal branches.
- Long-running shared work goes through `feat/<area>-<slug>`, owned by leader, multi-PR.

### §3 Commits
- Small. Meaningful. Conventional-commits style preferred (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Include affected trunk step in commit body (e.g. `T2: implements place_bid_v2 anti-snipe path`).
- Co-author trailers welcome for AI-pair sessions.

### §4 PR template (`.github/pull_request_template.md`)
```markdown
## Trunk step
T<N> | off-trunk

## What this PR does
<one paragraph>

## Linked dev-log
docs/dev-log/<date>-<who>.md

## Verification (exact commands)
- [ ] `make codegen` clean
- [ ] `make test` pass
- [ ] `make e2e-dummy-bid` pass (if T1+)
- [ ] `make verify` consistent (if T6+)
- [ ] manual check: <what you opened in the browser>

## Risk
<what could break; what falls back; rollback plan>

## All-member approve required?
- [ ] Touches `proto/*` or schema-shaped change → YES (per V9 §6)
- [ ] Implementation-only → NO
```

### §5 Tests
- Every PR lists exact commands or states blocked. "Tests added" is not specific enough.
- Implementation PRs MUST update tests in same PR (no "tests in follow-up").
- Refactor PRs MUST keep all tests passing.
- Contract PRs MUST include contract tests in `tools/contract-test/`.

### §6 Error handling
- Bidding core: NO silent fallback. Errors propagate to wire codes.
- AI sidecar: MAY degrade (return `AI_OFFLINE` placeholder, never block).
- WS gateway: panic isolation per connection (one bad client doesn't take down others).
- All errors include enough context for log → root cause without re-running.

### §7 Logging / metrics
- All log lines include `request_id`, plus `auction_id` / `user_id` / `seq` if applicable (per #15 §6 item 7).
- Use `slog` (Go stdlib structured logging).
- No `fmt.Println` in committed code. CI grep enforces.

### §8 Secrets
- Never in git / issue / PR / log / screenshot.
- See [15-security](15-security.md) §4 for the scan pipeline.
- Dev-log screenshots: redact API keys with image editor before commit (CI can't fully enforce).

### §9 Contract changes (Workflow v2 §6 + V9 §6)
- All-member approve for: `proto/*`, `apps/lumen/lua/*`, state machine, Stream event types, error codes, evidence hash chain, AI sidecar trigger.
- Implementation in `apps/lumen/internal/`, `apps/web/*/src/`, `apps/ai-sidecar/internal/`, `tools/*`: leader + 1 reviewer approve.
- Doc-only PRs in `docs/`: leader + 1 reviewer approve (lightweight).

## CI required checks (`.github/workflows/`)

Per V9 §9 + [#14 challenge 8]. All listed as **required status checks** on the `main` branch. `continue-on-error: false` on every required check.

| Workflow | Triggers | Check | Required? |
|---|---|---|---|
| `backend-ci.yml` | PR + push main | `go vet`, `go test ./...`, coverage per-package floor | YES |
| `web-ci.yml` | PR + push main | `pnpm lint`, `pnpm typecheck`, `pnpm test` | YES |
| `e2e-dummy-bid.yml` | PR + push main | `make e2e-dummy-bid` via compose | YES from T1; skip-stub before |
| `contracts-lint.yml` | PR | openapi lint, markdown link check, `make codegen` clean | YES |
| `secret-scan.yml` | PR + push main | gitleaks + trufflehog | YES |
| `dev-log-lint.yml` | PR | front-matter valid + no secret patterns | YES |
| `lua-grep.yml` | PR | `! grep -r '_v2\.lua' apps/` (enforces no `*_v2.lua` per V9 §0 reconciliation) | YES |
| `replay-verify.yml` | scheduled nightly | `make verify` against seeded auction | NO (nightly signal) |
| `load-smoke.yml` | manual + nightly | `make load-smoke` (50 bids, 5s) | NO |

### Coverage gates

Per V9 §9: per-package floor + named-suite existence, not just global percentage.

```yaml
# backend-ci.yml
- name: coverage gate
  run: |
    go test -coverprofile=coverage.out ./...
    go tool cover -func=coverage.out | tee coverage.txt
    # Per-package floors
    awk '/statemachine\// && $3 < 95.0 { exit 1 }' coverage.txt
    awk '/internal\/envelope\// && $3 < 80.0 { exit 1 }' coverage.txt
    awk '/internal\/catchup\// && $3 < 80.0 { exit 1 }' coverage.txt
    # Named-suite existence (test names must exist; lack of named test = gate fail)
    go test -run 'TestSeqMonotonic_500Concurrent|TestPlaceBid_DedupeReplay|TestHammerRace_PlaceBidVsClose' ./... | grep PASS
```

### `make` targets

```makefile
.PHONY: up down seed test e2e-dummy-bid verify verify-load load chaos clean codegen lint typecheck

up:
\tdocker compose up -d --wait

down:
\tdocker compose down -v

seed:
\tgo run ./tools/seed/...

test:
\tgo test ./...

e2e-dummy-bid:
\tgo run ./tools/ws-bot/cmd/e2e-dummy-bid

verify:
\tgo run ./tools/replay-verifier/cmd/verify --auction $${AUCTION:-seed-1} --mode settled

verify-load:
\tgo run ./tools/replay-verifier/cmd/verify --auction $${AUCTION} --mode settled

load:
\t./scripts/load/run-p0.sh

chaos:
\t./scripts/chaos/$$PHASE.sh

codegen:
\toapi-codegen -package api -generate types,server proto/openapi.yaml > apps/lumen/internal/api/types.gen.go
\tnpx openapi-typescript proto/openapi.yaml -o packages/shared/src/api-types.ts
\tsqlc generate
\tgo run ./tools/codegen/envelope-gen ./proto/ws-envelope.md
\tgo run ./tools/codegen/error-gen ./proto/error-codes.md
\t# Verify clean
\tgit diff --quiet || (echo "codegen produced uncommitted changes" && exit 1)

lint:
\tgolangci-lint run
\tcd apps/web/admin && pnpm lint
\tcd apps/web/mobile && pnpm lint

typecheck:
\tcd apps/web/admin && pnpm typecheck
\tcd apps/web/mobile && pnpm typecheck

clean:
\tdocker compose down -v --remove-orphans
\trm -rf apps/web/*/dist apps/web/*/node_modules
```

## Diverse-review merge gate

Per Workflow v2 §3: reviewers must **challenge**, not just approve. Implementation:

- PR template requires a "Risk" section that the leader must fill before requesting review.
- Reviewer's response template (in `.github/pull_request_template.md` footer):
  ```markdown
  ## Reviewer challenge (delete if leader)
  - AI tool used: <claude code | codex | cursor | other>
  - Prompt seed: <what you asked the AI to look for>
  - Findings: <bullet list>
  - Approve / Request Changes / Block: <one of the three>
  ```
- "Approve" alone is not enough — the merge gate parses reviewer comments and rejects PRs where no reviewer added a non-trivial finding/comment. (Set up in `merge-gate.yml`.)

## Branch protection

`main` branch protections:
- Require PR before merge
- Require 1 approving review
- Required status checks: all `YES` rows above
- Dismiss stale approvals on new push
- Require branches to be up to date before merging
- No force push, no deletion

## Test surface (workflow validation)

Process tests live in `.github/workflows/` themselves. Their "tests" are the CI runs.

| Validation | How |
|---|---|
| dev-log template parseable | `dev-log-lint.yml` fails on any malformed entry |
| Branch naming | `branch-name-check.yml` regex enforces `(elia|pdggk|farizzz)/.+` or `feat/.+` |
| No `*_v2.lua` files | `lua-grep.yml` greps `apps/` |
| `continue-on-error` not set | meta-check parses workflow yaml for required jobs |
| Codegen freshness | `contracts-lint.yml` runs `make codegen` and `git diff --quiet` |

## NEEDS HUMAN REVIEW

1. **Reviewer-challenge enforcement**: parsing reviewer comments for "non-trivial finding" is fragile. P0 might just rely on culture + the explicit "Findings" field in PR template. Defer automated enforcement.
2. **Dev-log frequency**: Workflow v2 says "every commit / PR / meaningful step". In practice will the team write at every commit? More realistic: every PR + every meaningful exploration session. Document expected cadence in `dev-rules.md` §0.
3. **AGENTS.md / CLAUDE.md updates**: PR #13 already has these. Should they cross-link to dev-log requirements? Probably yes — agents read these on session start.
4. **`required_profiles` in `.codex-pm.lock`**: PR #13 introduced this. Not in scope of this doc but flag for the team to confirm we're not picking up codex-pm conventions inadvertently.
