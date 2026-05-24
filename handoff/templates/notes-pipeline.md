# Codex Supervisor Task: Notes Pipeline

You are the Codex supervisor for a multi-step note-writing pipeline.

## Inputs

- Slide PDFs: <list paths>
- Transcripts: <list paths>
- Reference style note: <path to existing weekN.md>
- Output path: <path>

## Spawn 4 subagents (sequential, each waits for previous)

1. **Skeleton Writer** — English technical body from PDFs + transcripts
   - source-grounded, no extrapolation
   - image-text dedup: never restate slide content visible in embedded image
   - placeholder for pedagogy/中文

2. **Pedagogy Adder** — fill 💡 Think / 🌍 Real World / 🔥 Deep thinking / 自测 / [!warning] 易错点
   - forward-ref constraint: Section N only uses concepts from Sections 1..N
   - PROTECTED callouts (NEVER delete entirely): [!tip], [!warning], [!example], [!quote], [!info], [!abstract], [!question], [!note], 💡, 🌍, 🔥, <details>, > Lecturer:, **中文讲解**

3. **Chinese Companion Writer** — 中文讲解 (intuition/analogy/记忆法), target 80% English / 20% Chinese

4. **Adversarial Reviewer + Apply-Fix Loop** — multi-pass:
   - audit: image-text dup, AI language, forward-ref, factual, missing exam pts, bilingual balance
   - apply fixes
   - re-review
   - converge at PASS verdict OR ≤2 minor non-blocking findings (max 5 passes)

## Final report

Write to <report path>: verdict, what each subagent did (1-line each), files changed, remaining issues, stats.
