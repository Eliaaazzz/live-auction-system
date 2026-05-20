# AI Events Contract — v1 (DRAFT)

Owner: @C (AI / Infra Engineer) · Status: DRAFT — freeze by **Day 2 (2026-05-20)**

---

## Principles (non-negotiable)

1. **AI never mutates core auction state.** AI service has no Redis write access.
2. **VLM outputs facts DRAFT.** Seller must `PATCH /items/{id}/facts` to confirm before auction openable.
3. **LLM may only reference confirmed facts.** System prompt enforces this; output post-filtered.
4. **All AI outputs logged in `ai_logs`** (compliance + replay).
5. **High-risk fields require seller declaration**, not AI inference: `brand`, `authenticity`, `material`, `manufacture_year`. UI labels these "卖家声明 / AI 未验证".

---

## HTTP API (server-to-server, REST)

Base URL: `http://ai:8000/v1`

### POST `/vlm/facts`

Generate facts draft for an item. Called by API Gateway after `POST /api/items`.

**Request**:
```json
{
  "item_id": "01H...",
  "images": [
    "https://signed-url/img1.jpg",
    "https://signed-url/img2.jpg"
  ],
  "seller_text": "二手 LV 钱夹，2022 购入，9 成新，无大磕碰",
  "category_hint": "luxury_small_leather"
}
```

**Response** (200):
```json
{
  "draft_id": "01H...",
  "facts": {
    "category": "luxury_small_leather",
    "visible_condition": "9.0/10",
    "defects": ["内衬轻微磨损"],
    "suggested_start_cents": 80000,
    "color_visible": "棕色",
    "high_risk_fields_disclaimer": ["brand", "authenticity", "material"],
    "confidence": 0.78
  },
  "model": "Qwen2-VL-7B-Instruct",
  "model_version": "2025-08",
  "latency_ms": 1234
}
```

**Errors**:
- `503` — VLM model not loaded / OOM. Caller marks `ai_offline=true`, returns Item with empty draft for manual seller entry.

---

### POST `/llm/host` (Server-Sent Events)

Trigger AI auctioneer line. Streaming SSE. Called by AI Orchestrator on Redis Stream events.

**Request**:
```json
{
  "auction_id": "01H...",
  "trigger": "auction.started",
  "context": {
    "confirmed_facts": {
      "category": "luxury_small_leather",
      "visible_condition": "9.0/10",
      "seller_declared_brand": "LV (卖家声明)",
      "seller_declared_authenticity": "seller_claim_not_verified"
    },
    "current_state": {
      "max_amount_cents": 100000,
      "leader_id": "u_01H...",
      "ends_at_ms": 1747000000000,
      "seq": 42,
      "viewers": 312
    }
  },
  "language": "zh-CN",
  "max_tokens": 80
}
```

**Response** (SSE stream):
```
data: {"partial":"诸位"}
data: {"partial":"诸位看官，"}
data: {"partial":"诸位看官，这件 LV"}
...
data: {"final":"诸位看官，这件 LV 钱夹（卖家声明），起价 1000 元，加价 50。开始！","model":"Qwen2.5-7B-Instruct","latency_ms":420}
```

Trigger types:
| trigger              | when emitted                                  | tone                |
|----------------------|-----------------------------------------------|---------------------|
| `auction.started`    | rule.changed → state Bidding                   | 介绍 + 开拍         |
| `bid.accepted`       | seq advances, jump ≥ 2 × step                 | 庆祝跳涨            |
| `idle.30s`           | 30s no new bid in Bidding                     | 煽情催价            |
| `cooling.started`    | state → Cooling                                | 倒数提醒            |
| `hammered`           | state → Hammered                               | 收锤                |
| `passed`             | state → Passed / ReserveNotMet                | 安抚 + 下一场       |

---

### POST `/pricing/suggest-step` (P1, not P0)

Suggest a dynamic step bump. **Output is advisory only.** Seller must confirm; confirmation triggers `rule.changed` event on the auction.

**Request**:
```json
{
  "auction_id": "01H...",
  "current_state": { "qps": 4.2, "viewers": 540, "max_amount_cents": 200000, "step_cents": 5000 }
}
```

**Response**:
```json
{
  "suggested_step_cents": 10000,
  "reasoning": "qps=4.2 (high) + viewers=540 → step×2 keeps momentum"
}
```

---

### GET `/healthz`

Returns 200 only if VLM + LLM models loaded.

```json
{
  "vlm": { "ok": true, "model": "Qwen2-VL-7B-Instruct" },
  "llm": { "ok": true, "model": "Qwen2.5-7B-Instruct" },
  "uptime_s": 3601
}
```

---

## Guardrails

### LLM system prompt (frozen for P0)

```
你是一个直播拍卖 AI 主持人。你必须遵守：
1. 只能引用 confirmed_facts 中的字段。禁止编造品牌、真伪、材质、年代。
2. 涉及品牌/真伪时必须说"卖家声明"或"未验证"。
3. 单条输出不超过 80 字。
4. 不允许使用"保真"、"正品保证"、"绝对真品"等承诺性词语。
5. 不允许诱导赌博式消费。
当前 trigger: {trigger}
当前 context: {context}
```

### Output post-filter (regex blocklist)

`re.compile(r"(保真|正品保证|绝对真品|百分百|赌|盲拆)")` — match triggers reject + log + fallback to a canned line.

### Logging

Every VLM/LLM/pricing call writes to Postgres `ai_logs`:
```sql
ai_logs(id, auction_id, channel, trigger, prompt_hash, model, model_version, output, latency_ms, ts)
```

`prompt_hash` is sha256 of full prompt to allow audit without storing raw PII.

---

## Failure → degrade

| Failure                | Caller behavior                                                                |
|------------------------|--------------------------------------------------------------------------------|
| `/vlm/facts` 503       | Item created with empty `facts_draft`. Seller manual entry.                    |
| `/llm/host` 503 / SSE timeout | AI Orchestrator skips this event; client UI shows "AI 离线" badge.       |
| `/pricing/suggest-step` 503   | API Gateway returns current step unchanged.                              |

**Core auction MUST proceed during any AI outage.**

---

## Open questions

- [ ] TTS streaming endpoint (Stretch, P1): `/tts/stream` with CosyVoice — defer to Sprint 3 mid.
- [ ] Should LLM see live chat for atmosphere? Risk: prompt injection via chat. Tentative: no for P0.
- [ ] Multi-language: only `zh-CN` for P0?
