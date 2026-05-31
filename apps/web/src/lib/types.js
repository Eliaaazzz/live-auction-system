// src/lib/types.js
//
// Canonical wire constants — MUST stay in lock-step with backend `proto/`:
//   • proto/ws-envelope.md      — envelope shape + event types
//   • proto/error-codes.md      — bid rejection codes + CN copy keys
//   • proto/evidence-card.md    — evidence-only event types (timeline rows)
//   • docs/state-machine.md     — canonical 7 status values
//
// The single hard rule from the project blueprint §3 is:
//   "If a field name in this file disagrees with proto/, proto/ wins."

// ─── Envelope (proto/ws-envelope.md) ─────────────────────────────
// All WS traffic in BOTH directions uses this shape. Backend rejects
// envelopes with schemaVersion ≠ CURRENT_SCHEMA_VERSION.
export const CURRENT_SCHEMA_VERSION = 1;

// ─── Auction status (docs/state-machine.md — canonical 7 states) ─
export const AuctionStatus = Object.freeze({
  DRAFT:         'DRAFT',
  SCHEDULED:     'SCHEDULED',
  LIVE:          'LIVE',
  SOLD:          'SOLD',
  NO_BID:        'NO_BID',
  CANCELLED:     'CANCELLED',
  ORDER_CREATED: 'ORDER_CREATED',
});

// ─── WS event types ──────────────────────────────────────────────
// Two groups:
//
// 1. WIRE-BROADCAST  — server → client over WebSocket today
// 2. EVIDENCE-ONLY   — appear in evidence card timeline (auction_events table)
//                       but are NOT broadcast on the live WS. Client never
//                       sees these via RoomClient; only via api.getEvidence().
export const EventType = Object.freeze({
  // wire-broadcast (ws-envelope.md §3.2)
  ROOM_SNAPSHOT:     'ROOM_SNAPSHOT',
  BID_ACCEPTED:      'BID_ACCEPTED',
  BID_REJECTED:      'BID_REJECTED',
  AUCTION_EXTENDED:  'AUCTION_EXTENDED',  // anti-snipe (event, NOT a status)
  AUCTION_SOLD:      'AUCTION_SOLD',
  AUCTION_NO_BID:    'AUCTION_NO_BID',
  AUCTION_CANCELLED: 'AUCTION_CANCELLED',
  AI_COMMENTARY:     'AI_COMMENTARY',  // T7 §4.2: LLM auctioneer commentary, non-authoritative (proto/ai-events.md)
  PONG:              'PONG',

  // evidence-only (evidence-card.md §1 timeline)
  AUCTION_SCHEDULED: 'AUCTION_SCHEDULED', // emitted at freeze (DRAFT→SCHEDULED)
  AUCTION_STARTED:   'AUCTION_STARTED',   // emitted at start (SCHEDULED→LIVE)
  ORDER_CREATED:     'ORDER_CREATED',     // emitted by Order Service on SOLD
});

// Client → server (envelope.type values for outgoing frames)
export const ClientFrameType = Object.freeze({
  ROOM_JOIN: 'ROOM_JOIN',
  BID_PLACE: 'BID_PLACE',
  PING:      'PING',
});

// ─── Bid reject codes (proto/error-codes.md) ─────────────────────
// Visible to UI via `BID_REJECTED { code }` envelope. Use bidRejectCopy
// for CN-localized user-facing strings; never hardcode the string.
export const BidErrorCode = Object.freeze({
  ERR_NOT_LIVE:        'ERR_NOT_LIVE',
  ERR_AFTER_END:       'ERR_AFTER_END',
  ERR_TOO_LOW:         'ERR_TOO_LOW',
  ERR_RATE_LIMITED:    'ERR_RATE_LIMITED',
  ERR_AUCTION_PAUSED:  'ERR_AUCTION_PAUSED',
  ERR_NOT_ALLOWED:     'ERR_NOT_ALLOWED',
  ERR_BAD_INPUT:       'ERR_BAD_INPUT',
  ERR_INTERNAL:        'ERR_INTERNAL',
});

export const bidRejectCopy = Object.freeze({
  ERR_NOT_LIVE:        '本场已结束 · 无法继续出价',
  ERR_AFTER_END:       '已过截止时间',
  ERR_TOO_LOW:         '出价低于最低加价或超过上限',
  ERR_RATE_LIMITED:    '操作过快，请稍后再试',
  ERR_AUCTION_PAUSED:  '系统正在恢复 · 请稍候再试',
  ERR_NOT_ALLOWED:     '当前账号不能出价此场',
  ERR_BAD_INPUT:       '出价参数有误',
  ERR_INTERNAL:        '服务器繁忙 · 请重试',
});

// ─── Connection lifecycle (drives <ConnectionBar>) ───────────────
// Per blueprint §4 P7 — silent reconnect is FORBIDDEN.
export const ConnStatus = Object.freeze({
  IDLE:         'idle',
  CONNECTING:   'connecting',
  OPEN:         'ok',            // historical alias, used by store + components
  SYNCING:      'syncing',
  RECONNECTING: 'reconnecting',
  SCHEMA:       'schema',
});

// ─── VLM trust signal (proto/ai-events.md — T7) ──────────────────
// Surfaced in AdminVLMFacts header chip. The mock T1 sidecar returns
// modelName='mock-vlm-T1'; T7 returns the real Doubao model id.
export const VLM_MODEL_DEFAULT = Object.freeze({
  name:   'doubao-vision-pro-32k',
  vendor: 'Doubao',
  ver:    'v0.9.2',
});

// Hint for VLM facts that cannot be objectively verified by the model.
// Backend sets `highRisk: true` + ships the per-response disclaimer string
// in `highRiskFieldsDisclaimer`; this is the fallback copy.
export const HIGH_RISK_DISCLAIMER = '此项不可由 VLM 客观验证 · 信息以卖家声明为准';
