// Package advisor implements the NON-ADJUDICATING AI pricing / mode
// recommendation (issue #111, MVP slice). Before freezing rules, the seller's
// admin console can call /llm/recommend to get a SUGGESTED start price / step /
// reserve / auction mode plus a short rationale, derived from the item estimate,
// online viewers, historical comparable sales, and (optionally) an aggregate
// summary of a sealed warm-up phase.
//
// HARD INVARIANT (CLAUDE.md hard rule · V9 P3 · issue #70): AI is
// NON-AUTHORITATIVE. This endpoint only DRAFTS advice. The seller confirms,
// edits, or ignores it in the UI; the backend state machine adjudicates every
// accepted bid, winner, price, and terminal state. This package never writes
// auction state and the bid path never waits on it. Every response carries
// advisoryOnly=true and a disclaimer.
//
// OUT OF SCOPE here (issue #111 stretch — touches the FROZEN state machine and
// needs V9 §2 all-member ratify): the two-phase SEALED auction state and
// reserve-price ADJUDICATION. This package may CONSUME a pre-computed sealed
// summary, but it never runs the sealed phase and never decides a terminal.
//
// Spec: proto/ai-events.md §POST /llm/recommend.
package advisor

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Mode enumerates the auction modes the advisor may recommend. OPEN is the
// spec's public English auction (the only mode wired today); SEALED_THEN_OPEN
// is the issue #111 stretch and is recommendation-only until ratified.
type Mode string

const (
	ModeOpen           Mode = "OPEN"
	ModeSealedThenOpen Mode = "SEALED_THEN_OPEN"
)

// Request is the wire shape admin-console → backend → sidecar.
type Request struct {
	AuctionID string `json:"auctionId"` // optional: may be a pre-creation draft
	Item      Item   `json:"item"`
	Market    Market `json:"market"`
}

// Item describes the lot. EstValueCents is the seller/VLM estimate; money is a
// string at the boundary (proto convention — avoids JS number ambiguity).
type Item struct {
	Category      string `json:"category"`
	Title         string `json:"title"`
	EstValueCents string `json:"estValueCents"`
}

// Market carries demand signals. SealedSummary is OPTIONAL and AGGREGATE only —
// never individual sealed bids (confidentiality is the sealed-phase invariant).
type Market struct {
	OnlineViewers       int            `json:"onlineViewers"`
	HistoricalSoldCents []string       `json:"historicalSoldCents"`
	SealedSummary       *SealedSummary `json:"sealedSummary,omitempty"`
}

// SealedSummary is the aggregate of a sealed warm-up phase (issue #111 stretch).
type SealedSummary struct {
	Count       int    `json:"count"`
	MaxCents    string `json:"maxCents"`
	SecondCents string `json:"secondCents"`
	MedianCents string `json:"medianCents"`
}

// Response is advisory ONLY: advisoryOnly is always true and disclaimer is
// always set. The seller confirms; the backend adjudicates.
type Response struct {
	AdvisoryOnly    bool   `json:"advisoryOnly"`
	RecommendedMode Mode   `json:"recommendedMode"`
	StartPriceCents string `json:"startPriceCents"`
	StepCents       string `json:"stepCents"`
	ReserveCents    string `json:"reserveCents"`
	Rationale       string `json:"rationale"`
	Disclaimer      string `json:"disclaimer"`
	Fallback        bool   `json:"fallback"`
	ModelName       string `json:"modelName"`
}

const (
	maxRationaleLen = 80
	disclaimer      = "AI 建议仅供参考：由卖家确认，后端裁决最终成交与终态。"
	modelName       = "mock-advisor-111"
	// safeRationale replaces a rationale that fails the guardrail (or the whole
	// response on generator error). Generic, compliant, demo-safe.
	safeRationale = "依据成交估值与在线人数给出建议；请卖家结合实际确认。"
)

// Generator is the pluggable model call. Tests inject a deterministic impl;
// prod swaps a real Doubao client. It returns advice before guardrail/normalize.
type Generator func(req Request) (Advice, error)

// Advice is the raw model output before guardrail + normalization.
type Advice struct {
	Mode            Mode
	StartPriceCents string
	StepCents       string
	ReserveCents    string
	Rationale       string
}

// HandlerFunc wires the endpoint in main.go. The model call is pluggable.
func HandlerFunc(generate Generator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		resp := recommendWithGuardrail(req, generate)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// recommendWithGuardrail always returns a valid advisory Response — it never
// errors back to the caller (mirrors auctioneer.generateWithGuardrail: the
// seller UI always gets a usable suggestion + disclaimer; AI failure is silent).
//
// On generator error → full canned fallback (Fallback=true). On a rationale
// that trips the guardrail → swap only the text to safeRationale and keep the
// numeric advice (Fallback stays false; the numbers are unaffected by a text
// compliance miss).
func recommendWithGuardrail(req Request, generate Generator) Response {
	adv, err := generate(req)
	if err != nil {
		log.Printf("[advisor] generator failed auction=%s err=%v · falling back", req.AuctionID, err)
		return fallbackResponse()
	}
	mode := adv.Mode
	if mode != ModeOpen && mode != ModeSealedThenOpen {
		mode = ModeOpen // default to the only wired mode
	}
	if reason, bad := failsGuardrail(adv.Rationale); bad {
		log.Printf("[advisor] guardrail reason=%s rationale=%q · using safe rationale", reason, adv.Rationale)
		adv.Rationale = safeRationale
	}
	return Response{
		AdvisoryOnly:    true,
		RecommendedMode: mode,
		StartPriceCents: adv.StartPriceCents,
		StepCents:       adv.StepCents,
		ReserveCents:    adv.ReserveCents,
		Rationale:       adv.Rationale,
		Disclaimer:      disclaimer,
		Fallback:        false,
		ModelName:       modelName,
	}
}

func fallbackResponse() Response {
	return Response{
		AdvisoryOnly:    true,
		RecommendedMode: ModeOpen,
		Rationale:       safeRationale,
		Disclaimer:      disclaimer,
		Fallback:        true,
		ModelName:       modelName,
	}
}

// MockGenerator produces a context-aware recommendation without a real model.
// Heuristics are intentionally simple and transparent (this is advisory): it
// anchors on the strongest available demand signal — a sealed summary if a
// warm-up phase ran, else historical sales, else the seller's estimate.
func MockGenerator(req Request) (Advice, error) {
	// Sealed warm-up present → use the issue #111 §6 decision sketch.
	if s := req.Market.SealedSummary; s != nil && s.Count > 0 {
		return adviceFromSealed(s)
	}

	anchor := parseCents(req.Item.EstValueCents)
	source := "卖家估值"
	if hi := maxCents(req.Market.HistoricalSoldCents); hi > anchor {
		anchor = hi
		source = "历史成交"
	}
	if anchor <= 0 {
		return Advice{}, errors.New("no usable price signal")
	}

	// Open English auction: start below the anchor to build the climb; step
	// ≈ 1% of the anchor; reserve ≈ 80%.
	mode := ModeOpen
	rationale := source + "锚定 · 低起拍引导竞价爬升，保留价约 8 成。"
	// Many viewers → suggest a sealed warm-up to discover willingness-to-pay
	// before the open auction (recommendation only — see package scope note).
	if req.Market.OnlineViewers >= 200 {
		mode = ModeSealedThenOpen
		rationale = source + "锚定 · 人多，建议先暗拍预热探价，再开明拍。"
	}
	return Advice{
		Mode:            mode,
		StartPriceCents: itoa(anchor * 60 / 100),
		StepCents:       itoa(roundStep(anchor / 100)),
		ReserveCents:    itoa(anchor * 80 / 100),
		Rationale:       rationale,
	}, nil
}

// adviceFromSealed implements the issue #111 §6 decision sketch:
//   - one bid far above the pack (max ≥ 1.3 × second) → advise locking it in
//     early (no need to run the open auction).
//   - a tight cluster → open the floor near the median and let the English
//     auction climb to a higher clearing price.
func adviceFromSealed(s *SealedSummary) (Advice, error) {
	max := parseCents(s.MaxCents)
	second := parseCents(s.SecondCents)
	median := parseCents(s.MedianCents)
	if max <= 0 {
		return Advice{}, errors.New("sealed summary has no max")
	}
	step := itoa(roundStep(max / 100))
	if second > 0 && max >= second*13/10 {
		return Advice{
			Mode:            ModeOpen,
			StartPriceCents: itoa(second),
			StepCents:       step,
			ReserveCents:    itoa(second),
			Rationale:       "暗拍最高价远超次高 · 建议直接成交，提前锁定。",
		}, nil
	}
	floor := median
	if floor <= 0 {
		floor = second
	}
	return Advice{
		Mode:            ModeOpen,
		StartPriceCents: itoa(floor),
		StepCents:       step,
		ReserveCents:    itoa(floor),
		Rationale:       "暗拍出价集中 · 建议从中位起拍，明拍叫向更高。",
	}, nil
}

// ── guardrail ───────────────────────────────────────────────────────
// Mirrors apps/ai-sidecar/internal/auctioneer's seller/buyer-facing compliance
// checks, scoped here to the rationale text. (A future refactor could lift one
// shared guardrail package; duplicated now to keep this slice self-contained.)

var (
	reURL   = regexp.MustCompile(`(?i)\b(https?://|www\.)\S+`)
	rePhone = regexp.MustCompile(`\b\d{11}\b|\b\+\d{1,3}[ -]?\d{4,}\b`)
	reMoney = regexp.MustCompile(`(¥|\$|元)\s*\d`)
)

var bannedWords = []string{
	"绝对最低价",
	"仅此一件",
	"假一赔十",
	"保真",
	"百分百正品",
	"原价回收",
}

// failsGuardrail returns (reason, true) when text violates any rule.
func failsGuardrail(text string) (string, bool) {
	if utf8.RuneCountInString(text) > maxRationaleLen {
		return "len", true
	}
	if reURL.MatchString(text) {
		return "url", true
	}
	if rePhone.MatchString(text) {
		return "phone", true
	}
	if reMoney.MatchString(text) {
		return "money", true
	}
	for _, bad := range bannedWords {
		if strings.Contains(text, bad) {
			return "banned:" + bad, true
		}
	}
	return "", false
}

// ── small numeric helpers (money is a string at the boundary) ─────────

func parseCents(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func maxCents(list []string) int64 {
	var m int64
	for _, s := range list {
		if n := parseCents(s); n > m {
			m = n
		}
	}
	return m
}

// roundStep snaps a raw step down to a clean ¥100 (10000-cent) grid, floored at
// 10000, so the suggested increment lands on a tidy boundary.
func roundStep(raw int64) int64 {
	const unit = 10000
	if raw < unit {
		return unit
	}
	return (raw / unit) * unit
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
