# Conventions

## Communication

Use GitHub Issues and repository docs as the main shared record. Keep team-facing decisions in public docs or issues, and keep PDGGK-only workflow notes in `docs/team-memory/`. Do not assume other teammates follow the same AI workflow.

## Writing

Public docs should be short, source-grounded, and implementation-facing. Prefer “what is frozen / who owns it / how to verify it” over broad product prose. If V8 and the PDF differ, say “internal freeze” versus “official deadline” instead of smoothing the difference away.

Use English filenames and stable technical terms. Chinese is fine inside explanations when it matches the source language. Keep state names consistent in public docs: `Draft`, `Scheduled`, `Bidding`, `Cooling`, `Hammered`, `AwaitingSellerConfirm`, `Passed`, `ReserveNotMet`, `Settled`, `Cancelled`. Mention RFC aliases only where needed.

Do not copy shared API keys into docs, logs, prompts, examples, screenshots, or issue comments. Refer to “shared Doubao credentials from the PDF” only when absolutely necessary, and handle actual secret values outside public material.

## Naming

Project name for now: `Lumen Auction` in English docs, with “实时竞拍大师” as the challenge title. Components: `WS Gateway`, `Bid Engine`, `Timer Worker`, `Persistence Worker`, `Replay Verifier`, `AI Sidecar`.

## Git / PR Flow

Small PRs should map to frozen contracts: protocol, state machine, Redis Lua, schema, UI flow, load test, materials. Commit messages should name the surface, for example `docs: add auction state machine` or `realtime: add bid lua contract`. Do not mix private notes, public docs, and implementation code in one PR unless the task explicitly needs it.
