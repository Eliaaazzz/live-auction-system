# Codex Supervisor Task: Audit Only (read-only)

You audit an existing artifact. DO NOT modify any files.

## Target

<path to file/folder being audited>

## Spawn 4 subagents (parallel, read-only)

1. **Factual Auditor** — every claim traces to source?
2. **Redundancy Auditor** — image-text dup, repeated paragraphs, AI filler?
3. **Structure Auditor** — required sections present? formatting valid?
4. **Quote/Citation Verbatim Auditor** — every quote findable verbatim in source?

Synthesize one verdict report.

## Verdict format

```
## Verdict
PASS / NEEDS_MICRO_FIXES / NEEDS_MAJOR_REWORK

## Findings (per category, with line numbers)
[brief]

## Top 3 critical issues
1. ...

## Stats
- ...
```
