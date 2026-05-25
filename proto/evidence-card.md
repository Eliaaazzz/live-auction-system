# Evidence Card + Hash Chain (T4)

`[全员 approve: evidence/hash]` — this is a V9 §6 coupling surface. The field set, hash
algorithm, and canonical serialization below are consumed by the evidence-card UI and
the Replay Verifier (T6); changing any of them is a breaking change and needs all-member
sign-off.

Status: **v0 (T4)**. Authored late (the T0 draft was deferred); ratify before T6 builds
the Verifier against it.

## 1. Evidence card — `GET /api/auctions/{id}/evidence`

Requires a valid Lumen auth token. The timeline contains raw event payloads and the
order contains buyer/order fields, so v0 does not expose this endpoint anonymously.

```jsonc
{
  "auctionId":        "auc_…",
  "status":           "ORDER_CREATED",   // MySQL projection / order-derived summary
  "currentPriceCents":"11000",           // money-as-string
  "winnerId":         "user_…",          // from verified timeline/order; "" if none
  "seq":              2,                  // last seq
  "eventsCount":      2,
  "factsConfirmed":   true,
  "timeline":         [ EvidenceEvent, … ],   // §2, seq-ascending
  "eventsHash":       "<hex>",            // chain head = event_hash of the last event; "" if empty
  "chainVerified":    true,               // server recompute of the whole chain
  "hashBreakAtSeq":   3,                  // present ONLY when chainVerified=false
  "order":            Order,              // present ONLY when an order exists (auction sold)
  "note":             "…"
}
```

**Non-sale terminals** (`NO_BID`, `CANCELLED`) carry **no `winnerId` and empty `currentPriceCents`** — they are not sales (T3 TC-T3-013), so a cancelled/passed card can't be misread as a win. Only `SOLD` / `ORDER_CREATED` cards carry a winner + price.

`EvidenceEvent`:

```jsonc
{ "seq": 1, "eventType": "BID_ACCEPTED", "payload": { … }, "eventHash": "<hex>", "prevHash": "<hex>" }
```

`Order` (created on hammer/cap-hit SOLD; `orders` UNIQUE(auction_id) ⇒ exactly-once):

```jsonc
{ "id":"ord_auc_…", "auctionId":"auc_…", "productId":"prod_…", "buyerId":"user_…",
  "amountCents":"11000", "status":"created", "createdAt":"2026-05-25T…Z" }
```

## 2. Hash chain (the `[全员 approve]` core)

Per auction, over `auction_events` rows in **seq-ascending** order:

```
event_hash = lowerhex( HMAC_SHA256( EVIDENCE_HMAC_KEY, canonical ) )
canonical  = prev_hash || "\n" || dec(seq) || "\n" || event_type || "\n" || payload
```

- **prev_hash** — the previous event's `event_hash`; **`""` (empty) at genesis** (the lowest-seq event). Stored in `auction_events.prev_hash`.
- **dec(seq)** — base-10 ASCII of the int64 `seq`.
- **event_type** — the wire type string (`BID_ACCEPTED` / `AUCTION_SOLD` / …).
- **payload** — the **MySQL-normalized `payload_json` text**, i.e. the value returned by `SELECT payload_json` — **not** the original cjson bytes. MySQL JSON columns normalize key order/whitespace on storage, so a verifier MUST read `payload_json` from MySQL (or apply identical normalization) before hashing, or it will compute a different digest. The writer (Persistence Worker) hashes the same read-back form, so the two always agree on one deployment.
  - This assumes MySQL JSON normalization is stable for the deployed version. Re-verify after a MySQL upgrade; if normalization changes, pre-upgrade hashes may need an intentional re-chain.

A verifier recomputes the chain and reports the **first** offending seq as `hash_break_at_seq` when either: a `prev_hash` does not link to the running head, or an `event_hash` does not match a recompute over the stored payload (a post-hoc edit of payload or hash). An empty chain verifies.

Gate: `make verify-evidence` (= `lumen verify-evidence --auction <id>`) exits non-zero on a break (`hash_break_at_seq=<n>`). T6's `make verify` will fold this into the three-way diff.

## 3. HMAC key custody + threat model (§6 — honest scope)

- Key from `EVIDENCE_HMAC_KEY` (env / GitHub Secret / KMS). **Outside `APP_ENV=dev` a non-default value is required** (enforced in `config.Load`).
- **What this defends:** post-hoc single-point tampering of stored history — edit any `payload_json` or `event_hash` and the chain breaks at that seq, detectable by anyone holding the key.
- **What this is NOT:** external notarization / blockchain anchoring. And per §6, **if the HMAC key is readable by the same process/DB that writes the events, the guarantee collapses to a plain integrity/consistency check** (a writer who also has the key can re-chain a forgery). For the demo the key lives in process env, so we describe this as an **integrity/consistency check**, not tamper-proof evidence. Hardening (key in KMS, separate signer, rotation) is post-MVP.
- **Rotation:** changing the key invalidates recompute of pre-rotation rows; a rotation scheme (versioned key id per row) is deferred — out of scope for v0, noted here so the field set can grow compatibly.
- **Writer concurrency:** v0 still deploys one Persistence Worker. `fillEventHash` uses a transaction and row locks, and it refuses to chain seq N while seq N-1 exists without an `event_hash`; a multi-worker deployment must preserve this retry behavior or add a per-auction lease.

## 4. Schema

`auction_events(…, event_hash VARCHAR(128) NULL, prev_hash VARCHAR(128) NULL)` — nullable from T1, **filled by the Persistence Worker at T4** (idempotent, self-healing). `orders` UNIQUE(auction_id). See `proto/db-schema.md`.
