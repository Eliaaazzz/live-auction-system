# PR Review

1. Parse full diff; scan every file.
2. Rank risk: contracts, auth, data, Lua, CI.
3. Check software engineering principles, design patterns, code quality.
4. Review as Security, Correctness, API compatibility, Performance, Test coverage.
5. Pull callers/tests; check contract drift.
6. Run stated commands; report coverage, blockers, uncertainty.
7. Fetch/check out the PR branch locally and run it; do not rely on diff-only review when the change is executable.
8. Ask AI to generate edge cases and CS-style hidden tests for the risky behavior, including negative paths and boundary values.
9. After review, include proposed hidden-test files or test snippets in the PR comment so they can be copied into CI.
10. If local execution is blocked, state exactly which tests could not run and still provide the hidden-test plan/files.
