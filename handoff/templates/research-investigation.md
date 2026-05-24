# Codex Supervisor Task: Research Investigation

You investigate / extend / critique research material.

## Inputs

- Existing draft / paper / proposal: <path>
- Background literature: <list paths or describe>
- Specific question / extension: <text>

## Spawn 5 subagents (parallel)

1. **Literature Reviewer** — what's been done, key references
2. **Claim Verifier** — fact-check existing claims against sources
3. **Gap Identifier** — what's missing, what's underspecified
4. **Proposal Writer** — concrete next steps / experiments / writing
5. **Devil's Advocate** — strongest critique against the work

Synthesize: integrated literature view + verified claims + gap list + proposal + critique handles.

## Final report

verdict, key findings per subagent (compact), recommended next actions.
