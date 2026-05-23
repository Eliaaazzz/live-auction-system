# Component 11 — Web Admin (PC seller console)

> **Path**: `apps/web/admin/`
> **Owner discipline**: leader; AI facts-confirm UX is **all-member approve** (V9 §6 / rubric).
> **Gates trunk**: T1 (publish + freeze flow) → T7 (AI facts UX) → T10 (monitoring dashboard for live demo).
> **Cross-references**: [12-shared-package](12-shared-package.md), [06-auction-api](06-auction-api.md), [09-ai-sidecar](09-ai-sidecar.md).

## Purpose

Desktop-first React app for sellers / hosts to publish auctions, configure rules, monitor live state, and cancel abnormal auctions. Also where reviewers / mentors look at the monitoring dashboard during the demo.

Built with React + TypeScript + Vite + Zustand + AntD (desktop variant). Shares `packages/shared` with mobile.

## Directory layout

```
apps/web/admin/
├── package.json  vite.config.ts  tsconfig.json  index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── pages/
│   │   ├── Login/                  dev-login user switcher (P0)
│   │   ├── ProductList/            seller's products
│   │   ├── ProductEdit/            create/edit product
│   │   ├── AuctionList/            seller's auctions (filter by status)
│   │   ├── AuctionPublish/         the multi-step wizard (Product → Facts → Rules → Schedule)
│   │   ├── AuctionMonitor/         live view of all my auctions
│   │   ├── AuctionDetail/          single auction view (mirror of mobile Room but admin-only buttons)
│   │   ├── OrderList/              orders from my sold auctions
│   │   ├── EvidenceDetail/         evidence card viewer (same as mobile but more fields)
│   │   └── Observability/          Grafana iframe + key metrics summary
│   ├── features/
│   │   ├── publish-wizard/
│   │   │   ├── Step1Product.tsx
│   │   │   ├── Step2Facts.tsx      AI facts draft + confirm/edit
│   │   │   ├── Step3Rules.tsx      rule DSL form
│   │   │   └── Step4Review.tsx     review + freeze + start
│   │   ├── upload/                 image upload with magic-byte client check + preview
│   │   ├── rule-form/              validated form for FreezeRulesRequest
│   │   ├── monitoring/             live tile per auction with current price + status
│   │   ├── cancel/                 abnormal cancel modal (reason input)
│   │   └── grafana-embed/          iframe with auth pass-through
│   ├── store/
│   │   ├── ws.ts                   shared with mobile structure
│   │   ├── auctions.ts             my auctions index
│   │   ├── publish.ts              wizard state across steps
│   │   ├── monitor.ts              live state of all my auctions
│   │   └── auth.ts                 dev-login + role (seller | admin)
│   ├── lib/
│   │   ├── api.ts                  REST client
│   │   ├── magic-bytes.ts          client-side image format detection (defense in depth)
│   │   └── grafana.ts              Grafana URL builder
│   └── hooks/
│       ├── useMyAuctions.ts        live list with WS subscription per active auction
│       └── usePublishWizard.ts     wizard state machine
└── README.md
```

## Page tree

### `/login` — dev-login switcher
- Dropdown of seeded users (seller-1, seller-2, admin-1)
- Click "Login as <user>" → POST /dev-login → store token
- In production builds this page is unreachable (route gated by env)

### `/products`
- Table: ID, title, image thumbnail, has-active-auction, created date
- Action: "+ New product" → /products/new
- Each row: edit, view auctions

### `/products/new` and `/products/:id/edit`
- Form: title, description, images (upload), category
- Validates client-side; submits to REST
- "Use AI to draft facts" button → triggers `/facts/draft` and shows results

### `/auctions/new` — the publish wizard

```
Step 1: Pick a product
  [searchable list of my products]
  → Next

Step 2: AI facts draft
  Click "Generate" → AI sidecar /facts/draft
  Shows JSON form with each field editable
  Always-on banner: "High-risk fields disclaimer: ..."
  → Next requires explicit "Confirm these facts" button

Step 3: Rules
  Form fields:
    Start price: ¥ [input]  (default: 0)
    Increment:   ¥ [input]  (default: 100)
    Cap:         ¥ [input]  (default: 1,000,000)
    Duration:    [select: 1min / 5min / 30min / custom]
    Anti-snipe:  [select: 0s / 10s / 20s / 30s] (default 20s)
  Client-side validation matches server schema
  → Next

Step 4: Review + freeze
  Shows summary
  [Save as Draft] [Freeze Rules] [Freeze and Start Now]
  Freeze → POST /auctions/{id}/freeze → status SCHEDULED
  Start → POST /auctions/{id}/start → status LIVE → redirects to /auctions/{id}/monitor
```

### `/auctions` — list with filter

Filters: All | DRAFT | SCHEDULED | LIVE | terminal
Each row: ID, title, status badge, current price, end time, action menu (view, monitor, cancel)

### `/auctions/:id/monitor` — single auction live view

Same data as mobile Room but with:
- "Cancel auction" button (red, modal-protected, reason required)
- "Force start" button (if SCHEDULED)
- Full event log (last 100 events streaming)
- Top 50 leaderboard (not just top 5)
- Connection count gauge
- Server-time vs end-time delta

### `/observability`

```
┌─────────────────────────────────────────────────────────────┐
│  Lumen Auction System Health                                │
│  Status: ● HEALTHY   AI: ● ONLINE   Redis: ● UP             │
├─────────────────────────────────────────────────────────────┤
│  KPIs (last 5 min)                                          │
│  Active auctions: 3   |  Connections: 247                   │
│  Bids/sec:        18  |  ack p95: 42ms                      │
│  seq gap:         0   |  Stream lag: 0                      │
├─────────────────────────────────────────────────────────────┤
│  [iframe: Grafana auction-realtime dashboard]               │
└─────────────────────────────────────────────────────────────┘
```

Grafana iframe loads `infra/grafana/dashboards/auction-realtime.json` directly. Read-only token passed via URL.

### `/orders` — orders from my sold auctions

Table: order ID, auction title, buyer, price, status, created. Action: view.

### `/evidence/:auctionId`

Full evidence card with:
- Seller-confirmed facts JSON
- Frozen rules (all fields)
- Complete bid timeline (every event with seq)
- Anti-snipe extension log
- Hash chain head + "Verify" button (calls `tools/replay-verifier/` via internal endpoint that surfaces consistent / mismatch / hash_break)
- Download as JSON

## Key components

### `PublishWizard/Step2Facts.tsx`

```tsx
export function Step2Facts({ productId, onConfirm }: Props) {
  const [facts, setFacts] = useState<Record<string, unknown>>({})
  const [disclaimer, setDisclaimer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    setLoading(true); setError(null)
    try {
      const res = await api.factsDraft(productId)
      setFacts(res.facts)
      setDisclaimer(res.highRiskFieldsDisclaimer)
    } catch (e) {
      setError('AI facts unavailable. Please type manually.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="step-facts">
      <Button onClick={generate} loading={loading}>
        🤖 Generate facts from product images
      </Button>
      {error && <Alert type="warning" message={error} />}
      <FactsEditor value={facts} onChange={setFacts} />
      {disclaimer && (
        <Alert type="info" className="disclaimer" message={disclaimer} />
      )}
      <Button
        type="primary"
        disabled={!hasMinimalFacts(facts)}
        onClick={() => onConfirm({ facts, disclaimer })}
      >
        ✅ I confirm these facts are accurate
      </Button>
    </div>
  )
}
```

### `PublishWizard/Step3Rules.tsx`

```tsx
const ruleSchema = z.object({
  startCents: z.string().refine(s => BigInt(s) >= 0n, 'must be non-negative'),
  incrementCents: z.string().refine(s => BigInt(s) > 0n, 'must be > 0'),
  capCents: z.string().refine(s => BigInt(s) > 0n, 'must be > 0'),
  durationMs: z.number().min(10_000).max(86_400_000),
  antiSnipeMs: z.number().min(0).max(120_000),
}).refine(d => BigInt(d.capCents) > BigInt(d.startCents), 'cap must exceed start')
  .refine(d => d.antiSnipeMs <= d.durationMs, 'anti-snipe must not exceed duration')

export function Step3Rules({ value, onChange, onNext }: Props) {
  const form = useForm({ schema: ruleSchema, defaultValues: value })
  return (
    <form onSubmit={form.handleSubmit(onNext)}>
      <CentsInput name="startCents" label="Start price" />
      <CentsInput name="incrementCents" label="Minimum increment" />
      <CentsInput name="capCents" label="Cap price" />
      <Select name="durationMs" label="Duration" options={[
        { value: 60_000, label: '1 minute' },
        { value: 300_000, label: '5 minutes' },
        { value: 1_800_000, label: '30 minutes' },
      ]} />
      <Select name="antiSnipeMs" label="Anti-snipe extension" options={[
        { value: 0, label: 'Off' },
        { value: 10_000, label: '10 seconds' },
        { value: 20_000, label: '20 seconds' },
        { value: 30_000, label: '30 seconds' },
      ]} />
      <Button htmlType="submit">Next</Button>
    </form>
  )
}
```

### `Monitor/AuctionTile.tsx` — live tile

```tsx
export function AuctionTile({ auctionId }: { auctionId: string }) {
  const auction = useStore(s => s.monitor.auctions[auctionId])
  const ws = useStore(s => s.ws.client)

  useEffect(() => {
    ws?.joinRoom(auctionId)
    return () => ws?.leaveRoom(auctionId)
  }, [auctionId, ws])

  return (
    <Card>
      <StatusBadge status={auction.status} />
      <Title>{auction.title}</Title>
      <Price>{centsToDisplay(auction.currentPriceCents)}</Price>
      <Countdown endAtMs={auction.endAtMs} />
      <Stats>
        <li>Bids: {auction.bidCount}</li>
        <li>Top bidder: {auction.topUserId ?? '—'}</li>
        <li>Extensions: {auction.extendCount}</li>
      </Stats>
      {auction.status === 'LIVE' && (
        <DangerButton onClick={() => openCancelModal(auctionId)}>
          Cancel
        </DangerButton>
      )}
    </Card>
  )
}
```

## Cancel flow (abnormal)

```tsx
function CancelModal({ auctionId, onClose }: Props) {
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)

  return (
    <Modal title="Cancel auction" onCancel={onClose}>
      <Alert type="warning" message="This will immediately end the auction with no winner. Active bidders will see the cancellation." />
      <Input.TextArea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (visible in audit log)"
        required
      />
      <Checkbox checked={confirming} onChange={e => setConfirming(e.target.checked)}>
        I understand this is irreversible
      </Checkbox>
      <Button
        danger
        type="primary"
        disabled={!reason || !confirming}
        onClick={async () => {
          await api.cancel(auctionId, reason)
          onClose()
          message.success('Auction cancelled')
        }}
      >
        Cancel auction
      </Button>
    </Modal>
  )
}
```

## Test surface

| Test | Verifies |
|---|---|
| `PublishWizard_StepProgression` | step1 done → step2 unlocked; step2 done → step3 |
| `Step2Facts_GenerateCallsAI` | click generate → api.factsDraft called |
| `Step2Facts_DisclaimerShown` | api returns disclaimer → Alert with text |
| `Step2Facts_ConfirmRequiresFacts` | empty facts → confirm button disabled |
| `Step3Rules_ValidatesCapExceedsStart` | cap < start → form invalid |
| `Step3Rules_ValidatesAntiSnipeLeqDuration` | antiSnipe > duration → form invalid |
| `Step4Review_FreezeCallsAPI` | "Freeze" → POST /auctions/{id}/freeze |
| `Step4Review_FreezeAndStartFlow` | "Freeze and Start" → freeze then start sequentially |
| `MonitorTile_LiveUpdatesViaWS` | mock WS BID_ACCEPTED → tile price updates |
| `CancelModal_RequiresReasonAndCheckbox` | both fields needed before action enabled |
| `Observability_GrafanaIframeLoads` | iframe src matches dashboard URL |
| `EvidenceDetail_VerifyButtonCallsAPI` | click → calls verify endpoint, shows result |

Coverage target: **≥70%**.

## NEEDS HUMAN REVIEW

1. **Wizard state persistence**: if user closes browser mid-wizard, lose progress. Could persist to localStorage. P0: don't persist (KISS); P1 if needed.
2. **Image upload UX**: drag-and-drop vs file picker. AntD has both. Use both.
3. **Real-time event log on monitor page**: could be noisy at 100+ bids/min. Add filter + auto-scroll.
4. **Admin RBAC**: P0 = role is from JWT claim, hardcoded for seeded admin user. P1 = real role management.
5. **Grafana iframe auth**: dev = no auth; demo public deploy = read-only Grafana with anonymous viewer.
