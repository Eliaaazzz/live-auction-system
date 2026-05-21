# Codex Supervisor Task: Engineering Fix

You are the Codex supervisor for an engineering investigation + fix.

## Task

<describe the bug / feature / refactor>

## Spawn 5 subagents (parallel where safe)

1. **Root Cause Investigator** (read-only) — trace through codebase, find true root cause
2. **Minimal Patch Proposer** (read-only) — design smallest viable fix
3. **Architecture Reviewer** (read-only) — check for design smells, suggest cleanup
4. **Test/Reproduction Worker** (writer, isolated) — write failing test that reproduces issue
5. **Skeptical Reviewer** (read-only) — challenge proposed solution: edge cases, regression risk

After all return:
- Synthesize a single recommended fix
- Apply (one writer in main checkout, others use git worktrees if needed)
- Run tests
- Report

## Concurrency

- Read-only subagents: parallel
- Writers: serialize OR use git worktrees

## Final report

verdict, root cause summary, fix applied, tests added/passing, remaining risks, next action for parent.
