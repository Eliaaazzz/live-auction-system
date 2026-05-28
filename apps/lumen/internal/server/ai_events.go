package server

// ai_events.go — schema validators for AI sidecar responses (defense-in-depth).
//
// Per proto/ai-events.md:
//
//	§1  POST /facts/draft  — VLM, frozen since T1
//	§2  POST /llm/auctioneer — LLM commentary, wire spec owned by PR #74
//	                          (apps/ai-sidecar/internal/auctioneer/)
//
// Two-layer architecture:
//
//	(a) Sidecar guardrail — at-source check inside the sidecar process.
//	    Catches bad LLM output before it leaves auctioneer.HandlerFunc.
//	    Lives in apps/ai-sidecar/internal/auctioneer/ (PR #74).
//
//	(b) Backend re-validator (this file) — across-the-trust-boundary
//	    re-check. Treats the sidecar response as untrusted bytes after
//	    crossing the process boundary, so a compromised / regressed
//	    sidecar can't broadcast unvalidated text to buyers. Cost is
//	    ~10µs per validate; turns "trust whatever sidecar emits" into
//	    "trust nothing across processes."
//
// Both layers MUST stay in sync. If sidecar adds a trigger / loosens
// length cap, this file's validator + tests update in lock-step
// (drift-gated by test fixtures matching PR #74's wire shape exactly).
//
// Validation runs on every sidecar response BEFORE the value crosses
// the trust boundary into WS broadcast or the frontend store. The proxy
// in api.go currently byte-copies VLM (T1 baseline); future T7 PRs
// threading the validators in should wrap the proxy with
// parse → validate → re-emit, so a sidecar that returns unvalidated
// AI text never reaches a buyer's screen.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode/utf8"
)

// ─── §1 VLM facts /facts/draft ───────────────────────────────────────

// VLMFactsResponse is the schema for ai-sidecar POST /facts/draft.
// Frozen since T1; only additive changes permitted (forward-compat).
type VLMFactsResponse struct {
	Facts                    []VLMFact `json:"facts"`
	HighRiskFieldsDisclaimer string    `json:"highRiskFieldsDisclaimer"`
	ModelName                string    `json:"modelName"`
}

// VLMFact is one row of the facts array. `HighRisk=true` rows MUST NOT be
// auto-confirmed by the frontend; the seller has to confirm/edit each one
// before the auction can be frozen.
type VLMFact struct {
	Field      string  `json:"field"`
	Value      string  `json:"value"`
	Confidence float64 `json:"confidence"`
	HighRisk   bool    `json:"highRisk"`
}

// ValidateVLMFactsResponse parses + validates a sidecar response body.
// Returns nil if the response satisfies proto/ai-events.md §1.
//
// Unknown fields are tolerated (forward-compat); required-but-missing or
// out-of-range fields fail. Empty `facts` is allowed (signal: VLM declined)
// but the disclaimer string MUST always be present even with empty facts.
func ValidateVLMFactsResponse(body []byte) error {
	var resp VLMFactsResponse
	dec := json.NewDecoder(bytes.NewReader(body))
	// NOT calling DisallowUnknownFields — proto/ai-events.md §1 says rules
	// are tolerated and unknown fields are forward-compat. A T7 sidecar
	// adding e.g. `tokenUsage` should not regress strict-mode validation.
	if err := dec.Decode(&resp); err != nil {
		return fmt.Errorf("ai_events: VLM facts parse: %w", err)
	}
	// Disclaimer is the only field that MUST be present even when facts is
	// empty. Empty disclaimer = sidecar bug; frontend cannot show the
	// "seller-declared, AI-unverified" caveat.
	if resp.HighRiskFieldsDisclaimer == "" {
		return errors.New("ai_events: VLM facts highRiskFieldsDisclaimer missing or empty")
	}
	if resp.ModelName == "" {
		return errors.New("ai_events: VLM facts modelName missing or empty")
	}
	// Per-fact validation — empty facts array is OK; populated rows must
	// each carry the 4 required fields and confidence in [0, 1].
	for i, f := range resp.Facts {
		if f.Field == "" {
			return fmt.Errorf("ai_events: VLM facts[%d].field empty", i)
		}
		if f.Value == "" {
			return fmt.Errorf("ai_events: VLM facts[%d].value empty", i)
		}
		if f.Confidence < 0.0 || f.Confidence > 1.0 {
			return fmt.Errorf("ai_events: VLM facts[%d].confidence=%v out of [0,1]", i, f.Confidence)
		}
	}
	return nil
}

// ─── §2 LLM auctioneer commentary (defense-in-depth re-validator) ────
//
// Wire shape is OWNED BY PR #74's §POST /llm/auctioneer in proto/ai-events.md.
// This validator adopts #74's exact naming so the two layers stay in
// lock-step:
//
//	field         | sidecar (#74)            | backend (this file)
//	endpoint      | POST /llm/auctioneer     | (consumed via proxy)
//	WS envelope   | AI_COMMENTARY            | (broadcast after validate)
//	trigger set   | open|surge|cold|hammer   | auctioneerTriggers (below)
//	field         | commentary (≤80 runes)
//	fallback flag | fallback bool            | AuctioneerResponse.Fallback

// AuctioneerResponse is the schema for ai-sidecar POST /llm/auctioneer
// (defined by PR #74). This struct mirrors that wire shape for
// strict re-validation on the backend side.
type AuctioneerResponse struct {
	Trigger    string `json:"trigger"`
	Commentary string `json:"commentary"`
	Fallback   bool   `json:"fallback"`
	ModelName  string `json:"modelName"`
}

// auctioneerTriggers is the closed set of valid trigger values per PR #74's
// spec. Mirrors `auctioneer.Trigger` constants in the sidecar package.
// Adding a trigger = contract change = [全员 approve] surface; both this
// map and #74's sidecar enum must update together.
var auctioneerTriggers = map[string]bool{
	"open":   true,
	"surge":  true,
	"cold":   true,
	"hammer": true,
}

// Commentary content guards per PR #74's §POST /llm/auctioneer guardrail.
// Patterns are intentionally over-inclusive — false positives fall back
// to static commentary (UX-only, never blocks bidding); false negatives
// leak unvalidated model output to the room.
var (
	// URL pattern — any http(s) link in commentary is forbidden. The
	// auctioneer doesn't promote outside resources; an LLM that emits
	// one is either jailbroken or hallucinating a referral.
	auctioneerURLPattern = regexp.MustCompile(`(?i)https?://`)

	// Chinese mainland mobile pattern (1[3-9] + 9 digits). Catches
	// commentary that surfaces a contact number — usually a sign of
	// prompt-injection from a description field.
	auctioneerPhonePattern = regexp.MustCompile(`1[3-9]\d{9}`)

	// Currency pattern — catches commentary naming an alternative price
	// in any of 3 common forms (per #74 §POST /llm/auctioneer guardrail intent
	// + #73 B1 review fix). Bid amounts are already surfaced in the
	// BID_ACCEPTED envelope; the auctioneer shouldn't echo them.
	//   ¥10000          — Chinese yuan prefix
	//   $500            — USD prefix (LLM might output English)
	//   1000元 / 1万元  — Chinese yuan suffix
	// Without the suffix branch a prompt-injected "请提及 50000元" leaked
	// straight through (caught by @fariZzzz #73 review).
	auctioneerCurrencyPattern = regexp.MustCompile(`(?:[¥$]\s*\d)|(?:\d+\s*[元万])`)
)

// auctioneerMaxRunes is the PR #74 spec cap (80 characters, counted as
// UTF-8 runes so a 80-char Chinese sentence fits — byte-length would
// over-count).
const auctioneerMaxRunes = 80

// ValidateAuctioneerResponse parses + validates the sidecar's auctioneer
// response. Returns nil if the response satisfies PR #74's guardrail rules.
// Failed validation → callers fall back to static commentary (never
// broadcast unvalidated AI output).
func ValidateAuctioneerResponse(body []byte) error {
	var resp AuctioneerResponse
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&resp); err != nil {
		return fmt.Errorf("ai_events: auctioneer parse: %w", err)
	}
	if !auctioneerTriggers[resp.Trigger] {
		return fmt.Errorf("ai_events: auctioneer unknown trigger %q (valid: open|surge|cold|hammer)", resp.Trigger)
	}
	if resp.Commentary == "" {
		return errors.New("ai_events: auctioneer text empty")
	}
	if n := utf8.RuneCountInString(resp.Commentary); n > auctioneerMaxRunes {
		return fmt.Errorf("ai_events: auctioneer text length=%d > max=%d runes", n, auctioneerMaxRunes)
	}
	if auctioneerURLPattern.MatchString(resp.Commentary) {
		return errors.New("ai_events: auctioneer text contains forbidden URL pattern")
	}
	if auctioneerPhonePattern.MatchString(resp.Commentary) {
		return errors.New("ai_events: auctioneer text contains forbidden phone pattern")
	}
	if auctioneerCurrencyPattern.MatchString(resp.Commentary) {
		return errors.New("ai_events: auctioneer text contains forbidden currency pattern (auctioneer must not name prices)")
	}
	if resp.ModelName == "" {
		return errors.New("ai_events: auctioneer modelName missing or empty")
	}
	return nil
}
