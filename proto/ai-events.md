# AI Events Contract

VLM facts draft + LLM auctioneer. T1 ships the **mock** facts endpoint only; real Doubao + 4 triggers + streaming = T7. AI is non-authoritative and must degrade without blocking bidding.

## `POST /facts/draft` (ai-sidecar)

Request:
```json
{ "productId": "prod_x", "imageUrls": ["https://.../a.jpg"], "title": "...", "description": "..." }
```

Response (T1 mock returns this shape with canned values):
```json
{
  "facts": [
    { "field": "category", "value": "watch", "confidence": 0.91, "highRisk": false },
    { "field": "authenticity", "value": "unverified", "confidence": 0.0, "highRisk": true }
  ],
  "highRiskFieldsDisclaimer": "高风险字段为卖家声明，AI 未验证。",
  "modelName": "mock-vlm-T1"
}
```

Rules (enforced from T7 in `internal`/sidecar): VLM image fetch uses an **SSRF allowlist** (no private net / IMDS, size+timeout limits, no redirect-follow); product text is treated as **untrusted data** (never as instructions) to block prompt injection; `highRiskFieldsDisclaimer` is always present. The seller must `confirm/edit` facts before `freeze_rules` — AI output never auto-enters the core auction.

## `POST /auctioneer` (ai-sidecar · T7 §4.2)

Generates LLM auctioneer commentary for one of 4 triggers. Non-authoritative — V9 P3 says AI never gates bidding. Backend event hooks (separate PR) detect the trigger conditions and call this endpoint synchronously; the response is broadcast via the `AUCTIONEER_TEXT` wire event.

Request:
```json
{
  "auctionId":     "auc_x",
  "trigger":       "open" | "jump" | "cold" | "hammer",
  "ctx": {
    "currentPriceCents":   "12880000",
    "stepCents":           "500000",
    "winnerDisplayName":   "海风_2024",
    "extendCount":         2,
    "secondsSinceLastBid": 32
  }
}
```

Response (always 200; failures fall back to canned text):
```json
{
  "trigger":   "open",
  "text":      "蓝面 5711 起拍价 ¥120,000 · 这只海风的对手在哪里？",
  "fallback":  false,
  "modelName": "mock-llm-T7"
}
```

### Guardrail (enforced sidecar-side BEFORE returning to backend)

If the LLM output violates any of these, the sidecar returns the canned per-trigger fallback with `"fallback": true` AND logs the violation:

| Rule | Why | Action on violation |
|---|---|---|
| `len(text) ≤ 80` (Chinese chars + ASCII mix) | UI typewriter budget; long text scrolls past viewport | Truncate + log + fallback |
| No URL pattern (`https?://`, `www\.`) | Anti-phishing | Fallback + log |
| No phone pattern (`\d{11}` or international format) | Anti-bypass | Fallback + log |
| No `¥` or `$` or `元` followed by free-form numbers | Prevent LLM from inventing prices | Fallback + log |
| No banned-word match (see `apps/ai-sidecar/internal/badwords.go`) | Compliance: 绝对最低价 / 仅此一件 / 假一赔十 / 保真 etc. | Fallback + log |

### Wire broadcast: `AUCTIONEER_TEXT` event (server → client)

After the sidecar returns, the backend wraps and broadcasts:

```json
{
  "schemaVersion": 1,
  "type":          "AUCTIONEER_TEXT",
  "auctionId":     "auc_x",
  "seq":           null,
  "serverTimeMs":  1717819900000,
  "data": {
    "trigger":  "open",
    "text":     "蓝面 5711 起拍价 ¥120,000 · 这只海风的对手在哪里？",
    "fallback": false
  }
}
```

`seq: null` is deliberate — `AUCTIONEER_TEXT` is observability and NOT in the seqguard chain. Clients drop it without affecting `lastSeq`. If the LLM call fails or sidecar is down, the backend either skips the broadcast OR emits with canned fallback text — bidding is never blocked.

### Trigger conditions (backend event hooks — separate PR)

| Trigger | Backend condition | Frequency cap |
|---|---|---|
| `open` | Auction enters LIVE for the first time (`startLive` ack) | Once per auction |
| `jump` | `BID_ACCEPTED.amount ≥ previousAmount + 3·step`, AND ≥ 2 consecutive `BID_ACCEPTED` from different users | Cap 1/30s per auction (anti-spam) |
| `cold` | Auction is LIVE AND `now - lastBidAtMs > 30000` | Cap 1/60s per auction |
| `hammer` | `AUCTION_SOLD` event (cap-hit or timer hammer) | Once per auction |

`BID_REJECTED` does NOT trigger anything (only `BID_ACCEPTED` counts for `jump`). Cold trigger is suppressed for 5s after any `AUCTION_SOLD` / `AUCTION_NO_BID` / `AUCTION_CANCELLED` to avoid double-firing on `LIVE → terminal` transitions.
