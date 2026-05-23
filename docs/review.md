# PR Review

1. Parse full diff; scan every file.
2. Rank risk: contracts, auth, data, Lua, CI.
3. Deep-review risky files with callers/tests.
4. Check cross-file contract drift.
5. Run/verify stated commands.
6. Report coverage, blockers, uncertainty.
