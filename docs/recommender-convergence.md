# Mode recommender convergence plan

Status: post-foundation integration plan. This document is intentionally
non-runtime: it does not add an endpoint, change Lua adjudication, or change the
admin UI until the auction-mode foundation is merged.

## Why this exists

Issue #125 tracks a duplicate-recommender risk once the following PRs both land:

- PR #116 adds `POST /llm/recommend` as an AI-sidecar advisory path. AI remains
  non-authoritative and must not block auction creation or bidding.
- PR #117 adds auction-mode plumbing and a deterministic `POST /api/recommend-mode`
  heuristic path for the engine mode vocabulary.

Those two endpoints describe the same product action: recommend an auction mode
for a seller. Keeping both as production surfaces would make the admin client
choose one arbitrarily, while the other becomes dead code with a different
vocabulary and different fallback behavior.

## Canonical target

Use one production endpoint for the admin UI:

```text
POST /llm/recommend
```

The endpoint remains advisory. It should return an engine-mode recommendation,
rationale, confidence or fallback metadata, and alternatives. It must never
mutate auction state, freeze rules, place bids, close auctions, or bypass Redis
Lua adjudication.

The deterministic mode recommender from #117 becomes the fallback floor behind
that endpoint:

```text
admin UI -> /llm/recommend
             -> AI advisory attempt
             -> if AI unavailable, invalid, timed out, or disabled:
                  deterministic auction-mode heuristic
```

This keeps a single product contract while preserving the always-available
heuristic behavior required for demos and outages.

## Vocabulary mapping

Before production wiring, collapse advisory hints to engine modes explicitly.
Do not let the UI pass advisory-only terms to auction creation.

| Advisory hint | Engine mode | Notes |
|---|---|---|
| `OPEN` | `ENGLISH` | Default public ascending auction. |
| `SEALED_THEN_OPEN` | `PREQUALIFY` or `SEALED_FIRST` | Team decision required: two-act prequalify if the foundation exists; otherwise sealed first-price. |
| `SUDDEN_DEATH` | `SUDDEN_DEATH` | Only valid after the #117 mode enum lands. |
| `VICKREY` | `VICKREY` | Second-price sealed mode, not runner-up-pays. |
| `HYBRID_REVEAL` | `HYBRID_REVEAL` | Requires fast-reject guardrails from the mode foundation. |
| `ALL_PAY` | `ALL_PAY` | Virtual coins only; no normal order/payment path. |
| `RUNNER_UP_PAYS` | none yet | Design-only until the post-foundation contract exists. |

If the sidecar emits an unknown advisory hint, the wrapper must fall back to the
deterministic heuristic and include `fallbackReason: "unknown_mode_hint"`.

## Endpoint deprecation path

After #116 and #117 are both merged and the vocabulary decision above is made:

1. Move or import #117 deterministic scoring so `/llm/recommend` can call it as
   the fallback path.
2. Update the admin UI to call only `/llm/recommend`.
3. Make `POST /api/recommend-mode` return `410 Gone` with a small JSON body for
   one release window, or remove it in the same PR if no released client calls it.
4. Update proto/OpenAPI docs so only the canonical endpoint appears as the
   production surface.
5. Keep all recommendation output advisory; auction creation still validates
   `rules.mode` through the backend model and Lua-selected mode path.

Suggested `410 Gone` body:

```json
{
  "error": "MODE_RECOMMENDER_MOVED",
  "canonicalEndpoint": "/llm/recommend"
}
```

## Required tests before code wiring

- AI success: `/llm/recommend` returns a valid engine mode and rationale.
- AI timeout/offline: `/llm/recommend` returns the deterministic heuristic result
  with explicit fallback metadata.
- Unknown AI hint: wrapper does not leak the unknown hint to the UI; fallback is
  used instead.
- Deprecated endpoint: `/api/recommend-mode` returns `410 Gone` or is absent from
  the OpenAPI production surface.
- Admin UI: only one network call is made for mode recommendation.
- Guardrail: recommendation output is never accepted as authority for bid
  adjudication, closing, evidence, or settlement.

## Non-goals

- Do not implement runner-up-pays here. That mode remains design-only until the
  auction-mode foundation and virtual-liability contract are ratified.
- Do not change Redis Lua scripts in this convergence step.
- Do not require the AI sidecar for auction creation; the deterministic fallback
  must keep local demos functional.
