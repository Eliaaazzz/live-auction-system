package server

// auctioneer.go — backend trigger detection for the T7 §4.2 LLM auctioneer.
//
// Per proto/ai-events.md §POST /llm/auctioneer (+ #70 §4.2 + #73 spec).
//
// Architecture:
//   - 4 trigger detectors live on AuctioneerHooks (open/surge/cold/hammer)
//   - Each detector decides whether to fire based on per-auction state +
//     debounce caps documented in proto/ai-events.md
//   - Firing spawns a goroutine that POSTs to ai-sidecar /llm/auctioneer,
//     validates the response with the same guardrail rules as the sidecar
//     (defense-in-depth — sidecar's own check is the primary; backend
//     re-validation catches a malformed/tampered sidecar), and broadcasts
//     an AI_COMMENTARY envelope to the room via Hub.broadcast.
//   - V9 P3: the bid acceptance path NEVER awaits any of this. Detectors
//     are called from existing flows (handleStart, fanout, Timer Worker)
//     but always dispatch via `go a.fire(...)` so the caller returns
//     immediately. The bid is broadcast on the Stream-driven path
//     unchanged; commentary arrives whenever the LLM responds.
//
// Multi-gateway note: dedup state is per-process for the demo. With N
// gateways, each gateway will fire up to N times for the same trigger.
// Acceptable for V9 demo (single backend); a Redis-backed dedup (SETNX
// with TTL of debounce interval) is a clean follow-up if we shard.

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// AuctioneerHooks owns trigger detection state + dispatches to the sidecar.
// One instance per Server. All public methods are safe for concurrent use —
// detection state is guarded by `mu`.
type AuctioneerHooks struct {
	sidecarURL string
	hub        *Hub
	httpClient *http.Client
	metrics    *metrics.Registry

	mu sync.Mutex
	// per-auction debounce state
	lastSurgeAtMs map[string]int64 // when we last fired `surge` (debounce 5s)
	lastColdAtMs  map[string]int64 // when we last fired `cold` (debounce 30s)
	// per-auction surge detection state (last accepted bid)
	lastBidAtMs   map[string]int64
	lastBidAmount map[string]string // amountCents
	// per-auction terminal suppression (don't fire cold for 5s after SOLD/NO_BID/CANCELLED)
	terminalAtMs map[string]int64
	// per-auction "open" firing state — once-per-auction
	openFired map[string]bool
}

// NewAuctioneerHooks builds a fresh hooks instance. Caller wires it into the
// Server (api.go handleStart, ws.go fanout, timer.go reconcileActive).
func NewAuctioneerHooks(sidecarURL string, hub *Hub, client *http.Client) *AuctioneerHooks {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &AuctioneerHooks{
		sidecarURL:    sidecarURL,
		hub:           hub,
		httpClient:    client,
		lastSurgeAtMs: make(map[string]int64),
		lastColdAtMs:  make(map[string]int64),
		lastBidAtMs:   make(map[string]int64),
		lastBidAmount: make(map[string]string),
		terminalAtMs:  make(map[string]int64),
		openFired:     make(map[string]bool),
	}
}

// OnAuctionStart fires the `open` trigger when an auction enters LIVE for
// the first time. Called from handleStart after a successful OK_LIVE.
//
// Spec: fires once per auction (state hash `openFired[aid]=true`). A
// restart-and-resume scenario would re-fire `open` — acceptable for V9
// since it's UX-only and the auction owner is most likely re-launching
// after a real start failure.
func (a *AuctioneerHooks) OnAuctionStart(ctx context.Context, aid string, payload OpenContext) {
	a.mu.Lock()
	if a.openFired[aid] {
		a.mu.Unlock()
		return
	}
	a.openFired[aid] = true
	a.mu.Unlock()
	ctxData := map[string]any{
		"startPriceCents": payload.StartPriceCents,
		"endAtMs":         payload.EndAtMs,
	}
	go a.fire(ctx, aid, "open", ctxData)
}

// OnBidAccepted feeds the BID_ACCEPTED stream into the `surge` detector.
// Called from the fanout goroutine (ws.go) on
// every BID_ACCEPTED envelope it reads from the Stream.
//
// Spec: fires when delta ≥ 3·stepCents AND inter-arrival < 2s.
// Debounce: at most one fire per 5s per auction.
func (a *AuctioneerHooks) OnBidAccepted(ctx context.Context, aid string, b model.BidAcceptedData, stepCents string) {
	nowMs := time.Now().UnixMilli()

	a.mu.Lock()
	prevAtMs := a.lastBidAtMs[aid]
	prevAmount := a.lastBidAmount[aid]
	lastSurgeAtMs := a.lastSurgeAtMs[aid]
	a.lastBidAtMs[aid] = nowMs
	a.lastBidAmount[aid] = b.AmountCents
	a.mu.Unlock()

	// Need a prior bid to compute delta — first bid is never a `surge`.
	if prevAmount == "" || prevAtMs == 0 {
		return
	}
	// Inter-arrival check: must be a rapid pair (< 2s).
	if nowMs-prevAtMs >= 2_000 {
		return
	}
	// Delta check: ≥ 3·stepCents. BigInt because cents are decimal strings.
	if !deltaAtLeastThreeSteps(b.AmountCents, prevAmount, stepCents) {
		return
	}
	// Debounce: don't refire within 5s of the prior surge.
	if nowMs-lastSurgeAtMs < 5_000 {
		return
	}

	a.mu.Lock()
	a.lastSurgeAtMs[aid] = nowMs
	a.mu.Unlock()

	ctxData := map[string]any{
		"currentPriceCents":   b.AmountCents,
		"stepCents":           stepCents,
		"winnerDisplayName":   b.DisplayName,
		"secondsSinceLastBid": (nowMs - prevAtMs) / 1000,
	}
	go a.fire(ctx, aid, "surge", ctxData)
}

// OnTickStall is called by the Timer Worker every reconcile tick (5s) for
// each LIVE auction. Fires `cold` if the auction has been silent for
// > 30s and we haven't fired `cold` in the last 30s.
//
// Suppressed for 5s after any AUCTION_SOLD/NO_BID/CANCELLED — prevents
// the cold trigger from firing on the LIVE → terminal transition.
func (a *AuctioneerHooks) OnTickStall(ctx context.Context, aid, displayName string, currentPriceCents string) {
	nowMs := time.Now().UnixMilli()

	a.mu.Lock()
	lastBidAt := a.lastBidAtMs[aid]
	lastColdAt := a.lastColdAtMs[aid]
	termAt := a.terminalAtMs[aid]
	a.mu.Unlock()

	// Terminal suppression — don't fire cold within 5s of a terminal event.
	if termAt > 0 && nowMs-termAt < 5_000 {
		return
	}
	// Need a bid history to know "silence." If no bid yet, the auction is
	// fresh — `open` already fired and a separate `cold` for "no bids yet"
	// would compete with it.
	if lastBidAt == 0 {
		return
	}
	// Silent for at least 30s?
	if nowMs-lastBidAt < 30_000 {
		return
	}
	// Debounce: at most one cold per 30s.
	if nowMs-lastColdAt < 30_000 {
		return
	}

	a.mu.Lock()
	a.lastColdAtMs[aid] = nowMs
	a.mu.Unlock()

	ctxData := map[string]any{
		"currentPriceCents":   currentPriceCents,
		"winnerDisplayName":   displayName,
		"secondsSinceLastBid": (nowMs - lastBidAt) / 1000,
	}
	go a.fire(ctx, aid, "cold", ctxData)
}

// OnAuctionSold fires the `hammer` trigger when AUCTION_SOLD broadcasts.
// Called from the fanout goroutine on every AUCTION_SOLD envelope.
//
// Also flips terminalAtMs so the Timer Worker's `cold` detector skips for
// 5s — prevents cold + hammer from racing each other on the same auction.
func (a *AuctioneerHooks) OnAuctionSold(ctx context.Context, aid string, payload HammerContext) {
	nowMs := time.Now().UnixMilli()
	a.mu.Lock()
	a.terminalAtMs[aid] = nowMs
	a.mu.Unlock()

	ctxData := map[string]any{
		"currentPriceCents": payload.AmountCents,
		"winnerDisplayName": payload.WinnerDisplayName,
	}
	go a.fire(ctx, aid, "hammer", ctxData)
}

// OnAuctionTerminalNonSold is called from fanout on NO_BID/CANCELLED so
// the cold trigger's 5s suppression covers all terminal transitions.
func (a *AuctioneerHooks) OnAuctionTerminalNonSold(aid string) {
	a.mu.Lock()
	a.terminalAtMs[aid] = time.Now().UnixMilli()
	a.mu.Unlock()
}

// OpenContext is the trigger-specific context for `open`. Built by caller
// (handleStart) and forwarded into the sidecar request.
type OpenContext struct {
	StartPriceCents string
	EndAtMs         int64
}

// HammerContext is the trigger-specific context for `hammer`.
type HammerContext struct {
	AmountCents       string
	WinnerDisplayName string
}

// fire performs the sidecar call + guardrail re-validation + broadcast.
// Errors are logged but never returned — V9 P3, AI failure must not
// surface to the bid path.
func (a *AuctioneerHooks) fire(parentCtx context.Context, aid, trigger string, ctxData map[string]any) {
	// Every caller dispatches this as `go a.fire(...)`, so a panic here (bad
	// sidecar payload, nil map, etc.) would crash the WHOLE gateway. Firewall it:
	// AI is non-authoritative, a failed/​panicking dispatch must never take the
	// bidding engine down (spec deep-review: 异常兜底; AI 非裁决). Passing a.metrics
	// makes AI-dispatch panics observable in goroutinePanics too.
	defer recoverGoroutine("auctioneer.fire("+trigger+")", a.metrics)
	// Bounded timeout independent of parentCtx — even if the caller
	// (fanout / Timer) has a long-lived context, the LLM call should
	// never block beyond 5s. Failed call → canned fallback.
	ctx, cancel := context.WithTimeout(parentCtx, 5*time.Second)
	defer cancel()

	body, _ := json.Marshal(map[string]any{
		"auctionId": aid,
		"trigger":   trigger,
		"ctx":       ctxData,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.sidecarURL+"/llm/auctioneer", bytes.NewReader(body))
	if err != nil {
		log.Printf("[auctioneer] build request trigger=%s aid=%s: %v · falling back", trigger, aid, err)
		a.broadcast(aid, trigger, cannedFallback(trigger), true)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		log.Printf("[auctioneer] sidecar call trigger=%s aid=%s: %v · falling back", trigger, aid, err)
		a.broadcast(aid, trigger, cannedFallback(trigger), true)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[auctioneer] sidecar status=%d trigger=%s aid=%s · falling back", resp.StatusCode, trigger, aid)
		a.broadcast(aid, trigger, cannedFallback(trigger), true)
		return
	}

	var out struct {
		Trigger    string `json:"trigger"`
		Commentary string `json:"commentary"`
		Fallback   bool   `json:"fallback"`
		ModelName  string `json:"modelName"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		log.Printf("[auctioneer] sidecar decode trigger=%s aid=%s: %v · falling back", trigger, aid, err)
		a.broadcast(aid, trigger, cannedFallback(trigger), true)
		return
	}

	// Defense-in-depth: re-run the guardrail on the sidecar's text. The
	// sidecar applies its own check, but a corrupt sidecar or a real-LLM
	// regression could leak unsanitized output. Backend guardrail is the
	// final line before broadcasting to clients.
	if reason, bad := failsAuctioneerGuardrail(out.Commentary); bad {
		log.Printf("[auctioneer] guardrail FAIL trigger=%s aid=%s reason=%s text=%q · forcing fallback", trigger, aid, reason, out.Commentary)
		a.broadcast(aid, trigger, cannedFallback(trigger), true)
		return
	}

	a.broadcast(aid, trigger, out.Commentary, out.Fallback)
}

// broadcast emits the AI_COMMENTARY WS envelope to the room.
//
// `seq: 0` in the model.Envelope — this is intentional. The spec says
// `seq: null` for non-authoritative events; Go's int64 zero serializes
// to `0`, not `null`. Frontend's seqguard at the top of applyEvent
// exempts both `null` and `<=0` from dedup, so either form is safe.
// Future cleanup: if AI_COMMENTARY events ever come from the Stream
// (they don't — backend-only ephemeral), switch to a separate envelope
// shape without a seq field.
func (a *AuctioneerHooks) broadcast(aid, trigger, text string, fallback bool) {
	if a.hub == nil {
		// nil hub = unit-test mode; the tests assert via the broadcasts
		// channel below. Production always wires a real hub.
		return
	}
	dataJSON, _ := json.Marshal(map[string]any{
		"trigger":    trigger,
		"commentary": text,
		"fallback":   fallback,
	})
	env := model.Envelope{
		Type:         model.TypeAICommentary,
		AuctionID:    aid,
		Seq:          0, // serializes to 0; see comment above
		ServerTimeMs: time.Now().UnixMilli(),
		Data:         dataJSON,
	}
	b, _ := json.Marshal(env)
	a.hub.broadcast(aid, b)
}

// ─── guardrail (matches apps/ai-sidecar/internal/auctioneer.failsGuardrail) ───
//
// Backend defense-in-depth re-check. Sidecar runs the primary; if the
// sidecar is bypassed (corrupt response, real-LLM regression, attacker
// who can MITM the sidecar HTTP), this guardrail still catches it.

const maxAuctioneerTextRunes = 80

var (
	reAuctioneerURL   = regexp.MustCompile(`(?i)\b(https?://|www\.)\S+`)
	reAuctioneerPhone = regexp.MustCompile(`\b\d{11}\b|\b\+\d{1,3}[ -]?\d{4,}\b`)
	// Money: in lock-step with apps/lumen/internal/server/ai_events.go
	// auctioneerCurrencyPattern (Elia's #73 B1 fix). Catches:
	//   - ¥1000  $50            (symbol-before-digit prefix form)
	//   - 1000元  1万             (suffix form — Chinese is suffix-heavy)
	//   - 市价 50000元           (mid-string suffix; the prompt-injection
	//                            vector I flagged in #73 review)
	// Two-layer defense: ValidateAuctioneerResponse (ai_events.go) is
	// the authoritative re-validator; this regex is the per-trigger
	// dispatch guardrail in fire(). Both must catch the same patterns
	// or the layers drift — pin the patterns identical here.
	reAuctioneerMoney = regexp.MustCompile(`(?:[¥$]\s*\d)|(?:\d+\s*[元万])`)
)

var auctioneerBannedWords = []string{
	"绝对最低价", "仅此一件", "假一赔十", "保真", "百分百正品", "原价回收",
}

func failsAuctioneerGuardrail(text string) (string, bool) {
	if text == "" {
		return "empty", true
	}
	if utf8.RuneCountInString(text) > maxAuctioneerTextRunes {
		return "len", true
	}
	if reAuctioneerURL.MatchString(text) {
		return "url", true
	}
	if reAuctioneerPhone.MatchString(text) {
		return "phone", true
	}
	if reAuctioneerMoney.MatchString(text) {
		return "money", true
	}
	for _, bad := range auctioneerBannedWords {
		if strings.Contains(text, bad) {
			return "banned:" + bad, true
		}
	}
	return "", false
}

func cannedFallback(trigger string) string {
	switch trigger {
	case "open":
		return "拍卖正式开始 · 各位准备出价。"
	case "surge":
		return "竞争升温 · 出价幅度明显加大。"
	case "cold":
		return "场内沉寂 · 还有机会反手抢回。"
	case "hammer":
		return "落槌成交 · 恭喜得主。"
	}
	return "拍卖进行中。"
}

// ─── helpers ────────────────────────────────────────────────────────

// deltaAtLeastThreeSteps returns true when `cur - prev >= 3 * step`,
// using big.Int because cents are decimal strings spanning beyond
// int64 (per blueprint P1). A malformed string returns false rather
// than panicking — the trigger silently doesn't fire.
func deltaAtLeastThreeSteps(curStr, prevStr, stepStr string) bool {
	cur, ok := new(big.Int).SetString(curStr, 10)
	if !ok {
		return false
	}
	prev, ok := new(big.Int).SetString(prevStr, 10)
	if !ok {
		return false
	}
	step, ok := new(big.Int).SetString(stepStr, 10)
	if !ok || step.Sign() <= 0 {
		return false
	}
	delta := new(big.Int).Sub(cur, prev)
	threshold := new(big.Int).Mul(big.NewInt(3), step)
	return delta.Cmp(threshold) >= 0
}

// dispatchAuctioneer routes a Stream-driven event to the appropriate
// trigger detector. Called from the WS fanout goroutine (one per gateway).
//
// stepCents (needed for the surge delta check) is read from the
// authoritative state Hash via Snapshot, with a per-auction process-
// local cache (rules are frozen at SCHEDULED — cache safe).
//
// nil-safe: a fanout running in a mode without an auctioneer (rare —
// only direct test harness paths) just gets a no-op upstream.
func dispatchAuctioneer(ctx context.Context, a *AuctioneerHooks, aid string, st *store.Store, e store.StreamEvent) {
	switch e.Type {
	case model.TypeBidAccepted:
		var b model.BidAcceptedData
		if err := json.Unmarshal([]byte(e.Payload), &b); err != nil {
			return // malformed payload — don't crash the fanout
		}
		stepCents := auctioneerStep(ctx, st, aid)
		if stepCents == "" {
			return // no step in state Hash yet → can't compute delta
		}
		a.OnBidAccepted(ctx, aid, b, stepCents)

	case model.TypeAuctionSold:
		var s model.AuctionSoldData
		if err := json.Unmarshal([]byte(e.Payload), &s); err == nil {
			// AuctionSoldData carries WinnerID but not display name.
			// Sidecar's MockGenerator falls back to a default name
			// when WinnerDisplayName is empty; demo-acceptable. Real
			// Doubao swap could enrich here via a separate lookup
			// (post-MVP).
			a.OnAuctionSold(ctx, aid, HammerContext{
				AmountCents:       s.AmountCents,
				WinnerDisplayName: "", // see comment
			})
		}

	case model.TypeAuctionNoBid, model.TypeAuctionCancelled:
		// Suppress cold for 5s — terminal transition shouldn't get a
		// commentary fire (would compete with the room's NO_BID or
		// CANCELLED overlay).
		a.OnAuctionTerminalNonSold(aid)
	}
}

// auctioneerStep reads stepCents from the auction state Hash, with a
// per-auction in-process cache to avoid hammering Redis on every BID.
// Step is rules-frozen at SCHEDULED (cannot change after that), so the
// cache is safe for the lifetime of the auction.
//
// Returns "" when the step is unknown or unreadable — caller treats
// that as "skip the trigger detection."
var auctioneerStepCache sync.Map // aid → stepCents string

func auctioneerStep(ctx context.Context, st *store.Store, aid string) string {
	if v, ok := auctioneerStepCache.Load(aid); ok {
		return v.(string)
	}
	snap, err := st.Snapshot(ctx, aid)
	if err != nil || snap.Rules == nil || snap.Rules.StepCents == "" {
		return ""
	}
	auctioneerStepCache.Store(aid, snap.Rules.StepCents)
	return snap.Rules.StepCents
}
