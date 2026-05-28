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

### §1.2 SSRF allowlist + prompt-injection (T7 §4.1 — LIVE)

Implemented in `apps/ai-sidecar/internal/{ssrf,vlm}` (PR closing #70 §4.1). Status: **enforced**, not just documented.

- **SSRF guard** (`internal/ssrf/allowlist.go`): the image fetch runs through a guarded `http.Client` that rejects forbidden IPs **at dial time** (after DNS resolution, so a hostname resolving to a private IP is still blocked — URL-string blocklists are bypassable, IP-at-dial is robust):
  - blocked ranges: loopback (`127/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local incl. IMDS (`169.254/16`, pinned `169.254.169.254`), unspecified, multicast
  - redirects disabled (`CheckRedirect` → error; a `302 → http://169.254.169.254` is the classic SSRF-via-redirect bypass)
  - response capped at **10 MiB** (`io.LimitReader` at cap+1; exactly-cap allowed, cap+1 → `ErrTooLarge`)
  - **5s** dial + total timeout
  - the vetted IP is pinned for the actual dial so a DNS-rebind between check and connect can't slip a private IP in
- **Prompt-injection** (`internal/vlm/vlm.go buildPrompt`): seller title/description are embedded in an explicit `<<<SELLER_TEXT_UNTRUSTED … SELLER_TEXT_UNTRUSTED` fence, after a system instruction telling the model to treat the block as DATA never instructions. The fence delimiter token is stripped from the seller payload so it can't break out.
- **Mode toggle**: `VLM_MODE=real` + `VLM_DOUBAO_KEY` selects the Doubao path; unset → mock (`mock-vlm-T1`). A box without a key defaults safe (the deprovisioned-key risk in #70 §7). The Doubao HTTP call itself is stubbed (`callDoubao`) pending a re-provisioned key; the real path still runs the SSRF-guarded image fetch end-to-end so the security surface is exercised.

Tested by `apps/ai-sidecar/internal/ssrf/allowlist_test.go` (TC-T7-101 IMDS / 102 private / 103 redirect / 104 oversize) + `internal/vlm/vlm_test.go` (TC-T7-105 prompt-injection resistance).

## `POST /llm/auctioneer` (ai-sidecar · T7 §4.2)

Generates LLM auctioneer commentary for one of 4 triggers. Non-authoritative — V9 P3 says AI never gates bidding. Backend event hooks (separate PR) detect the trigger conditions and call this endpoint synchronously; the response is broadcast via the `AI_COMMENTARY` wire event.

Request:
```json
{
  "auctionId":     "auc_x",
  "trigger":       "open" | "surge" | "cold" | "hammer",
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
  "commentary": "蓝面 5711 起拍价 ¥120,000 · 这只海风的对手在哪里？",
  "fallback":  false,
  "modelName": "mock-llm-T7"
}
```

### Guardrail (enforced sidecar-side BEFORE returning to backend)

If the LLM output violates any of these, the sidecar returns the canned per-trigger fallback with `"fallback": true` AND logs the violation:

| Rule | Why | Action on violation |
|---|---|---|
| `len(commentary) ≤ 80` (Chinese chars + ASCII mix) | UI typewriter budget; long text scrolls past viewport | Truncate + log + fallback |
| No URL pattern (`https?://`, `www\.`) | Anti-phishing | Fallback + log |
| No phone pattern (`\d{11}` or international format) | Anti-bypass | Fallback + log |
| No `¥` or `$` or `元` followed by free-form numbers | Prevent LLM from inventing prices | Fallback + log |
| No banned-word match (see `apps/ai-sidecar/internal/badwords.go`) | Compliance: 绝对最低价 / 仅此一件 / 假一赔十 / 保真 etc. | Fallback + log |

### Wire broadcast: `AI_COMMENTARY` event (server → client)

After the sidecar returns, the backend wraps and broadcasts:

```json
{
  "schemaVersion": 1,
  "type":          "AI_COMMENTARY",
  "auctionId":     "auc_x",
  "seq":           null,
  "serverTimeMs":  1717819900000,
  "data": {
    "trigger":  "open",
    "commentary": "蓝面 5711 起拍价 ¥120,000 · 这只海风的对手在哪里？",
    "fallback": false
  }
}
```

`seq: null` is deliberate — `AI_COMMENTARY` is observability and NOT in the seqguard chain. Clients drop it without affecting `lastSeq`. If the LLM call fails or sidecar is down, the backend either skips the broadcast OR emits with canned fallback text — bidding is never blocked.

### Trigger conditions (backend event hooks — separate PR)

| Trigger | Backend condition | Frequency cap |
|---|---|---|
| `open` | Auction enters LIVE for the first time (`startLive` ack) | Once per auction |
| `surge` | `BID_ACCEPTED.amount ≥ previousAmount + 3·step`, AND ≥ 2 consecutive `BID_ACCEPTED` from different users | Cap 1/30s per auction (anti-spam) |
| `cold` | Auction is LIVE AND `now - lastBidAtMs > 30000` | Cap 1/60s per auction |
| `hammer` | `AUCTION_SOLD` event (cap-hit or timer hammer) | Once per auction |

`BID_REJECTED` does NOT trigger anything (only `BID_ACCEPTED` counts for `surge`). Cold trigger is suppressed for 5s after any `AUCTION_SOLD` / `AUCTION_NO_BID` / `AUCTION_CANCELLED` to avoid double-firing on `LIVE → terminal` transitions.
