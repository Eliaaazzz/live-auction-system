# Component 12 — Shared TS Package

> **Path**: `packages/shared/`
> **Owner discipline**: leader; type generation pipeline is **all-member approve** (V9 §6).
> **Gates trunk**: T0b (CI codegen gate online) → T1 (both web apps consume it).
> **Cross-references**: `proto/ws-envelope.md`, `proto/openapi.yaml`, `proto/error-codes.md`, [01-ws-gateway](01-ws-gateway.md), [10-web-mobile](10-web-mobile.md), [11-web-admin](11-web-admin.md).

## Purpose

Single TypeScript package consumed by both `apps/web/admin/` and `apps/web/mobile/`. Eliminates the failure mode where admin and mobile drift in their understanding of the WS envelope or REST contract. Built artifacts are committed (so consumer apps don't need a build of `packages/shared` at install time); source-vs-built drift is caught by CI.

Contract sources (`proto/*`) are upstream; this package mirrors them. `make codegen` re-runs generators and fails CI if the diff isn't committed.

## Directory layout

```
packages/shared/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              re-exports everything
│   ├── envelope.ts           WS envelope types — generated, do not edit
│   ├── api-types.ts          REST types from openapi.yaml — generated, do not edit
│   ├── error-codes.ts        error code enum from proto/error-codes.md — generated
│   ├── ws-client.ts          reconnect / heartbeat / lastSeq catchup
│   ├── seq-guard.ts          client-side dedupe + out-of-order drop
│   ├── time-sync.ts          serverClockOffsetMs helper
│   ├── money.ts              cents <-> display string formatters
│   └── audio.ts              shared sound assets (bid ticks, hammer) loader
├── dist/                     compiled output (committed)
├── tests/                    unit tests with vitest
└── README.md
```

## Key types

```ts
// src/envelope.ts (generated from proto/ws-envelope.md)
export type WsType =
  | 'ROOM_JOIN' | 'ROOM_LEAVE' | 'BID_PLACE' | 'CHAT_SEND' | 'PING'
  | 'ROOM_SNAPSHOT' | 'CATCHUP_EVENTS' | 'BID_ACCEPTED' | 'BID_REJECTED'
  | 'USER_OUTBID' | 'AUCTION_EXTENDED' | 'AUCTION_SOLD' | 'AUCTION_NO_BID'
  | 'AUCTION_CANCELLED' | 'AUCTION_STARTED' | 'AUCTION_FROZEN' | 'PONG'

export interface WsEnvelope<T = unknown> {
  type: WsType
  auctionId?: string
  requestId?: string
  traceId?: string
  serverInstanceId?: string
  seq?: number
  serverTimeMs: number
  data: T
  replayed?: boolean  // for DUPLICATE replays (per PR #13 ws-protocol.md)
}

export interface BidPlaceData {
  clientBidId: string
  amountCents: string  // string-at-boundary per V9 §0
}

export interface BidAcceptedData {
  seq: number
  userId: string
  displayName: string
  amountCents: string
  serverTimeMs: number
  endAtMs: number
  extendCount: number
  extended: boolean
  status: 'LIVE' | 'SOLD'
}

export interface BidRejectedData {
  code: ErrCode
  clientBidId?: string
  // Optional diagnostic fields (current price, min increment) — never trust as authoritative
  details?: Record<string, string>
}

// ... AuctionSoldData, AuctionExtendedData, etc. mirroring proto/ws-envelope.md
```

```ts
// src/error-codes.ts (generated from proto/error-codes.md)
export enum ErrCode {
  OK_ACCEPTED = 'OK_ACCEPTED',
  OK_SOLD = 'OK_SOLD',
  OK_NO_BID = 'OK_NO_BID',
  OK_CANCELLED = 'OK_CANCELLED',
  ERR_NOT_LIVE = 'ERR_NOT_LIVE',
  ERR_AFTER_END = 'ERR_AFTER_END',
  ERR_TOO_LOW = 'ERR_TOO_LOW',
  ERR_AUCTION_PAUSED = 'ERR_AUCTION_PAUSED',
  ERR_RATE_LIMITED = 'ERR_RATE_LIMITED',
  ERR_BAD_AMOUNT = 'ERR_BAD_AMOUNT',
  ERR_BAD_ENVELOPE = 'ERR_BAD_ENVELOPE',
  ERR_UNKNOWN_TYPE = 'ERR_UNKNOWN_TYPE',
  ERR_NOT_ALLOWED = 'ERR_NOT_ALLOWED',
  ERR_ENGINE_TIMEOUT = 'ERR_ENGINE_TIMEOUT',
  ERR_INTERNAL = 'ERR_INTERNAL',
  DUPLICATE = 'DUPLICATE',
}

// User-facing copy mapping (per language)
export const errCodeToCopy: Record<ErrCode, { zh: string; en: string }> = {
  [ErrCode.ERR_NOT_LIVE]: { zh: '竞拍已结束', en: 'Auction not live' },
  [ErrCode.ERR_AFTER_END]: { zh: '竞拍刚结束，您慢了一步', en: 'Auction just ended' },
  [ErrCode.ERR_TOO_LOW]: { zh: '出价不符合规则', en: 'Invalid bid amount' },
  [ErrCode.ERR_AUCTION_PAUSED]: { zh: '系统短暂暂停，请稍后再试', en: 'Auction temporarily paused' },
  [ErrCode.ERR_RATE_LIMITED]: { zh: '出价太频繁，请稍候', en: 'Too many bids' },
  // ... etc
}
```

## Key modules

### `ws-client.ts` — reconnect, heartbeat, catchup

```ts
import { WsEnvelope, WsType } from './envelope'
import { SeqGuard } from './seq-guard'
import { TimeSync } from './time-sync'

export interface WsClientOpts {
  url: string
  token: string
  onEvent: (env: WsEnvelope) => void
  onStateChange?: (state: WsClientState) => void
  reconnectBaseMs?: number  // default 500
  reconnectMaxMs?: number   // default 8000
  heartbeatMs?: number      // default 25_000
}

export type WsClientState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export class WsClient {
  private ws?: WebSocket
  private state: WsClientState = 'closed'
  private seqGuard = new SeqGuard()
  private timeSync = new TimeSync()
  private rooms = new Map<string, number>()  // auctionId -> lastSeq
  private reconnectAttempt = 0
  private heartbeatTimer?: number
  private opts: Required<WsClientOpts>

  constructor(opts: WsClientOpts) {
    this.opts = withDefaults(opts)
  }

  connect(): void {
    this.setState('connecting')
    const url = `${this.opts.url}?token=${encodeURIComponent(this.opts.token)}`
    this.ws = new WebSocket(url)
    this.ws.onopen = this.onOpen
    this.ws.onmessage = this.onMessage
    this.ws.onclose = this.onClose
    this.ws.onerror = this.onError
  }

  joinRoom(auctionId: string, lastSeq = 0): void {
    this.rooms.set(auctionId, lastSeq)
    this.send({
      type: 'ROOM_JOIN',
      auctionId,
      serverTimeMs: this.timeSync.now(),
      data: { auctionId, lastSeq },
    })
  }

  leaveRoom(auctionId: string): void {
    this.rooms.delete(auctionId)
    this.send({
      type: 'ROOM_LEAVE',
      auctionId,
      serverTimeMs: this.timeSync.now(),
      data: { auctionId },
    })
  }

  placeBid(auctionId: string, clientBidId: string, amountCents: string): void {
    this.send({
      type: 'BID_PLACE',
      auctionId,
      requestId: crypto.randomUUID(),
      serverTimeMs: this.timeSync.now(),
      data: { clientBidId, amountCents },
    })
  }

  private onOpen = () => {
    this.setState('open')
    this.reconnectAttempt = 0
    this.startHeartbeat()
    // Re-join any rooms we were in, requesting catchup
    for (const [aid, lastSeq] of this.rooms.entries()) {
      this.joinRoom(aid, lastSeq)
    }
  }

  private onMessage = (e: MessageEvent) => {
    let env: WsEnvelope
    try { env = JSON.parse(e.data) } catch { return }

    // Update server time offset
    this.timeSync.observe(env.serverTimeMs)

    // PONG handled internally
    if (env.type === 'PONG') return

    // Sequence guard: drop out-of-order or duplicate
    if (env.auctionId && env.seq !== undefined) {
      const verdict = this.seqGuard.observe(env.auctionId, env.seq, env.type)
      if (verdict === 'duplicate' || verdict === 'out-of-order') return
      this.rooms.set(env.auctionId, env.seq)
    }

    this.opts.onEvent(env)
  }

  private onClose = () => {
    this.stopHeartbeat()
    if (this.state !== 'closed') this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting')
    const backoff = Math.min(
      this.opts.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.opts.reconnectMaxMs
    )
    const jitter = backoff * 0.3 * (Math.random() - 0.5)
    setTimeout(() => this.connect(), backoff + jitter)
    this.reconnectAttempt++
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: 'PING', serverTimeMs: this.timeSync.now(), data: {} })
    }, this.opts.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  private send(env: WsEnvelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(env))
  }

  private setState(s: WsClientState): void {
    this.state = s
    this.opts.onStateChange?.(s)
  }

  close(): void {
    this.setState('closed')
    this.ws?.close()
  }
}
```

### `seq-guard.ts` — drop out-of-order / duplicate

```ts
type Verdict = 'fresh' | 'duplicate' | 'out-of-order' | 'extend-event'

export class SeqGuard {
  private highWater = new Map<string, number>()  // auctionId -> max seq seen
  private extendSeen = new Map<string, Set<number>>()  // anti-snipe events share seq with bid

  observe(auctionId: string, seq: number, type: string): Verdict {
    const hw = this.highWater.get(auctionId) ?? 0

    // Special case: AUCTION_EXTENDED shares seq with the bid that triggered it.
    // Both must be applied; dedupe by (seq, type).
    if (type === 'AUCTION_EXTENDED') {
      const seen = this.extendSeen.get(auctionId) ?? new Set()
      if (seen.has(seq)) return 'duplicate'
      seen.add(seq)
      this.extendSeen.set(auctionId, seen)
      return 'extend-event'
    }

    if (seq <= hw) return seq === hw ? 'duplicate' : 'out-of-order'
    this.highWater.set(auctionId, seq)
    return 'fresh'
  }

  getLastSeq(auctionId: string): number {
    return this.highWater.get(auctionId) ?? 0
  }

  reset(auctionId: string): void {
    this.highWater.delete(auctionId)
    this.extendSeen.delete(auctionId)
  }
}
```

### `time-sync.ts` — server clock offset for countdown

```ts
export class TimeSync {
  private offsetMs = 0  // serverTime = clientTime + offset
  private samples: number[] = []
  private readonly maxSamples = 10

  observe(serverTimeMs: number): void {
    const sample = serverTimeMs - Date.now()
    this.samples.push(sample)
    if (this.samples.length > this.maxSamples) this.samples.shift()
    // Use median, not mean, to resist outliers from network jitter
    this.offsetMs = median(this.samples)
  }

  now(): number {
    return Date.now() + this.offsetMs
  }
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
```

### `money.ts` — cents formatting

```ts
export function centsToDisplay(cents: string | number, currency = 'CNY'): string {
  const c = typeof cents === 'string' ? BigInt(cents) : BigInt(cents)
  const yuan = c / 100n
  const fen = c % 100n
  return `¥${yuan.toString()}.${fen.toString().padStart(2, '0')}`
}

export function displayToCents(display: string): string {
  const cleaned = display.replace(/[^\d.]/g, '')
  const [yuan, fen = '0'] = cleaned.split('.')
  return (BigInt(yuan) * 100n + BigInt(fen.padEnd(2, '0').slice(0, 2))).toString()
}
```

## Codegen pipeline

`tools/codegen/`:
- `envelope-gen/` — parses `proto/ws-envelope.md` tables → emits `envelope.ts` type unions
- `error-gen/` — parses `proto/error-codes.md` → emits `error-codes.ts` enum + copy map skeleton
- Wraps `npx openapi-typescript` for `api-types.ts`

`make codegen` runs all generators, then `git diff --quiet` fails CI if anything would have been regenerated differently.

## Test surface (vitest)

| Test | Verifies |
|---|---|
| `WsClient.reconnect.backoff` | close → reconnect attempts use exponential backoff with jitter |
| `WsClient.rejoin_rooms_with_lastSeq` | on reconnect, ROOM_JOIN sent for all previously-joined rooms with stored lastSeq |
| `WsClient.heartbeat_sent_every_25s` | mocked timer; PING messages emitted on schedule |
| `WsClient.pong_handled_silently` | PONG received → no event delivered to user; deadline reset |
| `SeqGuard.fresh_seq` | first observation of a seq → 'fresh' |
| `SeqGuard.duplicate_seq` | repeat seq → 'duplicate' |
| `SeqGuard.out_of_order` | seq 5 then seq 3 → seq 3 'out-of-order' |
| `SeqGuard.extend_event_shares_seq` | BID_ACCEPTED@seq=5 then AUCTION_EXTENDED@seq=5 → both applied |
| `TimeSync.median_resistance` | inject 1 outlier sample → median offset stable |
| `Money.centsToDisplay_largeAmounts` | BigInt 9999999999 cents → ¥99999999.99 |
| `Money.roundtrip` | display → cents → display = original |
| `ErrCode.copy_zh_completeness` | every ErrCode has both zh and en copy |

Coverage target: **≥90%** (small package, easy to test exhaustively).

## NEEDS HUMAN REVIEW

1. **Built artifacts committed**: tradeoff between consumer simplicity and PR noise. `pnpm` workspaces would make build-on-install work, but adds setup friction. **My vote: commit `dist/` for P0; revisit at P1.**
2. **Vitest vs Jest**: vitest is faster + ESM-native. **My vote: vitest.** No strong reason to deviate.
3. **`BigInt` for money in tsv2**: target browsers all support BigInt. ES2020 baseline assumed.
4. **`crypto.randomUUID`** browser support: works in 92%+ browsers. Polyfill if needed for mobile coverage.
