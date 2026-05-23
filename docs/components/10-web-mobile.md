# Component 10 — Web Mobile (H5 viewer)

> **Path**: `apps/web/mobile/`
> **Owner discipline**: leader; component contracts (props that bind to WS events) are **all-member approve** (V9 §6).
> **Gates trunk**: T1 (room shell + dummy bid UI) → T2 (full bid flow + animations) → T10 (polish).
> **Cross-references**: [12-shared-package](12-shared-package.md), `proto/ws-envelope.md`, `proto/openapi.yaml`.

## Purpose

The mobile H5 viewer is the **end-user experience** that the rubric "氛围动画 / 紧张感" graders see. It also drives the demo. Built with React + TypeScript + Vite + Zustand + Ant Design Mobile. Consumes `packages/shared` for WS client and types.

Per #14 challenge 7: **MP4 only for T1-T10. No webcam.** Webcam → P2.

## Directory layout

```
apps/web/mobile/
├── package.json  vite.config.ts  tsconfig.json  index.html
├── public/
│   ├── demo/                    fetched by scripts/dev/fetch-demo-video.sh (gitignored)
│   │   └── auction-demo.mp4
│   └── sounds/                  bid tick, hammer, outbid (committed; small)
├── src/
│   ├── main.tsx                 entry; routes; WsClient setup
│   ├── App.tsx                  root layout
│   ├── pages/
│   │   ├── Home/                auction list (active + ending soon)
│   │   ├── Room/                live room shell
│   │   ├── History/             past auctions, my bids, evidence cards
│   │   └── Order/               my orders, mock-pay flow
│   ├── features/
│   │   ├── video/               MP4Player (no webcam in T1-T10)
│   │   ├── bid/                 BidButton, BidPanel, BidConfirmModal
│   │   ├── leaderboard/         TopList, MyPosition
│   │   ├── countdown/           Countdown with server-time drift correction
│   │   ├── animations/          LeadToast, OutbidToast, ExtendedToast, HammerOverlay
│   │   ├── evidence-card/       view + verify button
│   │   ├── chat/                soft channel display
│   │   └── ai/                  auctioneer bubble + offline badge
│   ├── store/                   Zustand slices
│   │   ├── ws.ts                ws connection state + room subscriptions
│   │   ├── auction.ts           current auction state (driven by WS events)
│   │   ├── bid.ts               pending bid + last ack
│   │   ├── leaderboard.ts       top N + my position
│   │   └── auth.ts              dev-login token, user profile
│   ├── lib/
│   │   ├── api.ts               REST client (typed from packages/shared)
│   │   ├── audio.ts             play sound helpers
│   │   ├── haptics.ts           navigator.vibrate wrappers
│   │   └── analytics.ts         no-op in P0; placeholder
│   ├── hooks/
│   │   ├── useWs.ts             subscribe to WS events via store
│   │   ├── useCountdown.ts      ms-precision countdown with drift correction
│   │   ├── useAudio.ts          preload + play
│   │   └── useDevLogin.ts       quick switcher between seeded users
│   └── styles/
│       └── theme.ts             AntD Mobile theme overrides
└── README.md
```

## Page tree

### `/` (Home)
- Active auctions list (sorted by ending soonest)
- "Ending in N seconds" chips
- Quick filter: live | ending soon | ended

### `/auctions/:id` (Room — the main view)

```
┌─────────────────────────────────────────────────────────────┐
│   [MP4 video, looped, muted, autoplay; 16:9 letterbox]      │
│   AI-OFFLINE badge (if sidecar 503)                         │
├─────────────────────────────────────────────────────────────┤
│   Product title + thumbnail strip (3 images)                │
├─────────────────────────────────────────────────────────────┤
│   Current price: ¥123,456                                   │
│   Top bidder: 买家037 (you)                                  │
│   Countdown: 00:42.3  [pulses red when <10s]                │
│                                                             │
│   [+¥1,000 BID NOW]  ← BidButton (haptic + sound on tap)   │
│                                                             │
│   Last 5 bids ▼                                             │
│   • 买家037  ¥123,456  3s ago                                │
│   • 买家015  ¥122,456  8s ago                                │
│   ...                                                       │
├─────────────────────────────────────────────────────────────┤
│   Leaderboard (top 5)                                       │
│   Your position: #1                                         │
├─────────────────────────────────────────────────────────────┤
│   AI Auctioneer:                                            │
│   "出价踊跃！下一位会是 ¥124,456 吗？"                          │
├─────────────────────────────────────────────────────────────┤
│   Chat (collapsed by default)                               │
└─────────────────────────────────────────────────────────────┘
```

### `/auctions/:id/result` (post-terminal)
- "You won!" / "Outbid" / "No bids" banner
- Evidence card view button
- Mock pay button (if winner)

### `/me/orders` (my orders)
- List of orders with status (CREATED / PAID)
- Each → detail page with mock-pay action

### `/me/history` (my bid history)
- List of auctions I bid on, win/loss outcome

## Key components

### `Room.tsx` — main shell

```tsx
export function Room() {
  const { id: auctionId } = useParams()
  const ws = useStore(s => s.ws.client)
  const auction = useStore(s => s.auction.current)
  const wsState = useStore(s => s.ws.state)

  useEffect(() => {
    if (!ws || !auctionId) return
    ws.joinRoom(auctionId)
    return () => ws.leaveRoom(auctionId)
  }, [ws, auctionId])

  // Initial fetch via REST snapshot (concurrent with WS join)
  useSnapshot(auctionId)

  return (
    <div className="room">
      <VideoPlayer src="/demo/auction-demo.mp4" />
      <AIOfflineBadge />
      <ProductHeader auction={auction} />
      <CurrentPriceBlock auction={auction} />
      <Countdown endAtMs={auction?.endAtMs} />
      <BidButton auction={auction} />
      <RecentBids auctionId={auctionId} />
      <Leaderboard auctionId={auctionId} />
      <AuctioneerBubble />
      <Chat />
      <ConnectionBanner state={wsState} />
    </div>
  )
}
```

### `BidButton.tsx`

```tsx
export function BidButton({ auction }: { auction: AuctionState }) {
  const ws = useStore(s => s.ws.client)
  const userId = useStore(s => s.auth.user?.id)
  const [pending, setPending] = useState(false)
  const [cooldownMs, setCooldownMs] = useState(0)

  const isWinning = auction?.topUserId === userId
  const minBidCents = (BigInt(auction.currentPriceCents) + BigInt(auction.incrementCents)).toString()
  const disabled = pending || cooldownMs > 0 || auction?.status !== 'LIVE'

  const onTap = useDebouncedCallback(async () => {
    if (disabled || !ws) return
    setPending(true)
    const clientBidId = crypto.randomUUID()
    ws.placeBid(auction.id, clientBidId, minBidCents)
    playSound('bid-tick')
    navigator.vibrate?.(20)
    // Ack arrives via WS event; store handles updating pending=false
    setTimeout(() => setPending(false), 200)
  }, 100)  // 100ms debounce to prevent triple-click

  return (
    <button
      className={`bid-button ${isWinning ? 'leading' : ''}`}
      onClick={onTap}
      disabled={disabled}
    >
      {pending ? '出价中...' : `+ ¥${centsToDisplay(auction.incrementCents)} 出价`}
    </button>
  )
}
```

### `Countdown.tsx` — ms-precision with server-time drift

```tsx
export function Countdown({ endAtMs }: { endAtMs?: number }) {
  const timeSync = useStore(s => s.ws.timeSync)
  const [remainingMs, setRemainingMs] = useState<number>(0)
  const rafRef = useRef<number>()

  useEffect(() => {
    if (!endAtMs) return
    const tick = () => {
      const now = timeSync.now()  // server-time-aware
      const r = Math.max(0, endAtMs - now)
      setRemainingMs(r)
      if (r > 0) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current!)
  }, [endAtMs, timeSync])

  const seconds = Math.floor(remainingMs / 1000)
  const ms = Math.floor((remainingMs % 1000) / 100)
  const urgent = remainingMs < 10_000
  return (
    <div className={`countdown ${urgent ? 'pulse-red' : ''}`}>
      {String(Math.floor(seconds / 60)).padStart(2, '0')}:
      {String(seconds % 60).padStart(2, '0')}.{ms}
    </div>
  )
}
```

### Animations — toast triggers

```tsx
// hooks/useWsEvents.ts
useWsEvent('BID_ACCEPTED', (env) => {
  const data = env.data as BidAcceptedData
  store.auction.applyBid(data)
  if (data.userId === store.auth.user?.id) {
    showToast({ type: 'lead', icon: '🎉', text: '领先！' })
    playSound('lead')
  }
})

useWsEvent('USER_OUTBID', (env) => {
  // Only delivered to the user who got outbid
  showToast({ type: 'outbid', icon: '⚡', text: '被超越！' })
  playSound('outbid')
  navigator.vibrate?.([30, 10, 30])
})

useWsEvent('AUCTION_EXTENDED', (env) => {
  const data = env.data as AuctionExtendedData
  store.auction.setEndAtMs(data.newEndAtMs)
  showToast({ type: 'extended', icon: '⏱', text: `延长 ${data.newEndAtMs - prev}ms` })
})

useWsEvent('AUCTION_SOLD', (env) => {
  const data = env.data as AuctionSoldData
  showOverlay({ kind: 'hammer', winner: data.winnerUserId, price: data.finalPriceCents })
  playSound('hammer')
}, { once: true })
```

### Zustand store slices

```ts
// store/auction.ts
interface AuctionSlice {
  current?: AuctionState
  applyBid: (data: BidAcceptedData) => void
  applyExtended: (data: AuctionExtendedData) => void
  applyTerminal: (status: 'SOLD' | 'NO_BID' | 'CANCELLED', data: TerminalData) => void
  setSnapshot: (snap: RoomSnapshot) => void
  reset: () => void
}

export const auctionSlice: StateCreator<RootStore, [], [], AuctionSlice> = (set) => ({
  applyBid: (data) => set(state => {
    if (!state.current) return state
    return {
      current: {
        ...state.current,
        currentPriceCents: data.amountCents,
        topUserId: data.userId,
        endAtMs: data.endAtMs,
        extendCount: data.extendCount,
        seq: data.seq,
      },
    }
  }),
  // ...
})
```

## Audio + haptics

`public/sounds/`:
- `bid-tick.mp3` — short click on bid placed (~50ms)
- `lead.mp3` — short ascending tone (~200ms)
- `outbid.mp3` — short descending tone (~200ms)
- `hammer.mp3` — gavel strike (~500ms)
- `countdown-tick.mp3` — soft tick at last 5 seconds (~50ms each)

All preloaded on Room mount via `<audio>` elements (mobile autoplay restrictions handled by playing on first user interaction).

Haptics via `navigator.vibrate()` — degrades gracefully on iOS Safari (no support).

## REST API usage

For setup (auction list, my orders) and for snapshot fallback when WS catchup overflows. All calls typed via `packages/shared/api-types.ts`.

```ts
// lib/api.ts
import type { paths } from 'shared/api-types'

export const api = {
  listAuctions: () => fetch('/api/auctions').then(r => r.json()) as Promise<AuctionList>,
  getAuction: (id: string) => fetch(`/api/auctions/${id}`).then(r => r.json()),
  getSnapshot: (id: string) => fetch(`/api/auctions/${id}/snapshot`).then(r => r.json()) as Promise<RoomSnapshot>,
  getEvidence: (id: string) => fetch(`/api/auctions/${id}/evidence`).then(r => r.json()),
  myOrders: () => fetch('/api/me/orders').then(r => r.json()),
  mockPay: (orderId: string) => fetch(`/api/orders/${orderId}/mock-pay`, { method: 'POST' }),
  devLogin: (userId: string) => fetch('/api/dev-login', { method: 'POST', body: JSON.stringify({ userId }) }),
}
```

## Test surface

| Test (vitest + @testing-library/react) | Verifies |
|---|---|
| `Room_render_initial` | mounts with no auction data; shows loading |
| `Room_render_with_snapshot` | given mock REST snapshot → all blocks visible |
| `BidButton_tapPlacesBid` | tap → ws.placeBid called with correct args |
| `BidButton_debounced` | 3 taps in 50ms → only 1 ws.placeBid |
| `BidButton_disabledWhenWinning` | topUserId === me → button shows "leading" state |
| `BidButton_disabledWhenTerminal` | status SOLD → button disabled |
| `Countdown_msPrecision` | endAtMs in 1500ms → 00:01.5 displayed |
| `Countdown_pulseRedUnder10s` | <10s → CSS class includes pulse-red |
| `LeadToast_onMyBidAccepted` | BID_ACCEPTED with userId=me → toast shown, sound played |
| `OutbidToast_onUserOutbid` | USER_OUTBID event → toast + vibrate |
| `ExtendedToast_onAntiSnipe` | AUCTION_EXTENDED → endAtMs updates, toast shown |
| `HammerOverlay_onAuctionSold` | AUCTION_SOLD → overlay with winner |
| `Snapshot_fallback_on_ws_disconnect` | WS down → REST snapshot used to render auction |

Coverage target: **≥75%** (lower than backend because UI is harder to fully test; visual review covers the gap).

Plus a manual demo checklist for T10:
- [ ] Open 3 tabs, all show same auction
- [ ] Bid in tab 1 → tabs 2 and 3 update within 1s
- [ ] Tab 2 wins → tab 1 sees "outbid" toast
- [ ] Last 5 seconds: countdown pulses red, sound ticks each second
- [ ] Anti-snipe extension: toast appears, countdown jumps
- [ ] Hammer: overlay appears in all tabs
- [ ] Evidence card: opens, hash chain verifies
- [ ] Force WS disconnect (devtools): banner shows, reconnect within 3s, no missed events

## NEEDS HUMAN REVIEW

1. **AntD Mobile theming**: project provides decent default. Need ~5 color overrides for the auction-y vibe. Defer to T10 polish.
2. **Locale**: P0 = Chinese only. i18n hooks structured for future en/zh switch.
3. **Image loading**: product images can be large; need lazy loading + blurhash placeholder. P0: `<img loading="lazy">`; P1: blurhash.
4. **Offline mode**: zero support. WS dropped → banner. No service worker.
5. **Animation library**: framer-motion would be nicer but adds 30KB. P0: CSS transitions; P1 if needed.
