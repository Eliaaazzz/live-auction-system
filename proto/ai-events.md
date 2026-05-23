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
