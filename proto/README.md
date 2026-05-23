# `proto/` — canonical contracts (the seam)

Per [Plan V9 §6](../../../issues/1): all cross-component coupling converges here. Anything in this folder is the **all-member approve** boundary — changing a contract = changing the seam = needs @Eliaaazzz + @PDGGK + @fariZzzz sign-off. Changes inside a component's `internal/` are leader-only.

Materialized from PR #13 canonical `docs/*` (the SoT). Where this folder and `docs/` overlap, **`proto/` is canonical** and `docs/` should become a pointer (link-check enforced once #13 merges).

| File | Bounds | T1 status |
|---|---|---|
| [`ws-envelope.md`](ws-envelope.md) | WS message types + envelope + money-as-string | consumed by T1 |
| [`redis-keys.md`](redis-keys.md) | hash-tag keys + Lua signatures/returns | consumed by T1 (incl. **new** `start_auction`/`freeze_rules` returns) |
| [`error-codes.md`](error-codes.md) | Lua-internal ↔ wire code mapping | consumed by T1 |
| [`db-schema.md`](db-schema.md) | MySQL tables + constraints | consumed by T1 (hash fields land T4) |
| [`ai-events.md`](ai-events.md) | VLM facts mock schema | consumed by T1 (real Doubao T7) |

Canonical decisions baked in (per [#14 challenge comment](../../../issues/14#issuecomment-4523316287)):
canonical 5-terminal state machine · single `ERR_TOO_LOW` · `event_hash` computed in Persistence Worker (MySQL-only, "integrity check") · no `*_v2.lua` · single `seq` · Stream ID `<seq>-0` · Redis TIME `>=`.
