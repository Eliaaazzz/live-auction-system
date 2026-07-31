// Package auctioneer implements the LLM-driven auctioneer commentary
// generator (T7 §4.2). Backend event hooks call /llm/auctioneer when one of
// the 4 trigger conditions fires (open/surge/cold/hammer); this package
// runs the LLM call (mocked in T1 → mock-llm-T7; real Doubao in prod)
// and applies the V9-compliance guardrail BEFORE returning text to the
// backend.
//
// V9 P3 invariant: AI is non-authoritative. The bid path NEVER waits on
// this package — backend hooks call it asynchronously and broadcast the
// result via WS. Failure → fallback to canned text, never block.
//
// Spec: proto/ai-events.md §POST /llm/auctioneer.
package auctioneer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/llm"
)

// Trigger enumerates the 4 auctioneer triggers per spec.
type Trigger string

const (
	TriggerOpen   Trigger = "open"
	TriggerSurge  Trigger = "surge"
	TriggerCold   Trigger = "cold"
	TriggerHammer Trigger = "hammer"
)

// Request mirrors the wire shape backend → sidecar.
type Request struct {
	AuctionID string  `json:"auctionId"`
	Trigger   Trigger `json:"trigger"`
	Ctx       Ctx     `json:"ctx"`
}

// Ctx carries the rendering context the LLM uses to compose commentary.
// All fields optional — sidecar fills defaults for any missing field.
type Ctx struct {
	CurrentPriceCents   string `json:"currentPriceCents"`
	StepCents           string `json:"stepCents"`
	WinnerDisplayName   string `json:"winnerDisplayName"`
	ExtendCount         int    `json:"extendCount"`
	SecondsSinceLastBid int    `json:"secondsSinceLastBid"`
}

// Response is what the sidecar returns to backend.
type Response struct {
	Trigger    Trigger `json:"trigger"`
	Commentary string  `json:"commentary"`
	Fallback   bool    `json:"fallback"`
	ModelName  string  `json:"modelName"`
}

// maxTextLen is the spec'd budget per ai-events.md §guardrail (Chinese-
// char-friendly: counts runes not bytes, ≤80 fits comfortably in the
// AIBubble typewriter without scrolling).
const maxTextLen = 80

const mockModelName = "mock-llm-T7"

// Compiled once at package init for hot-path use.
var (
	reURL   = regexp.MustCompile(`(?i)\b(https?://|www\.)\S+`)
	rePhone = regexp.MustCompile(`\b\d{11}\b|\b\+\d{1,3}[ -]?\d{4,}\b`)
	// Free-form money pattern: currency symbol followed by digits.
	// Tight to avoid matching legitimate auction prices in the canned
	// fallback (those are formatted by the backend, not LLM-generated).
	reMoney = regexp.MustCompile(`[¥$€£]\s*\d|\d(?:[\d,.]*\d)?\s*(?i:yuan|rmb|cny|usd|eur|gbp)\b`)
)

// bannedWords mirrors compliance per spec. Production list lives in
// apps/ai-sidecar/internal/badwords.json (or a Chinese sensitive-word
// dict); this package ships a starter seed enforced by tests.
var bannedWords = []string{
	"absolute lowest price",
	"only one in existence",
	"tenfold refund",
	"guaranteed authentic",
	"100% genuine",
	"buyback at original price",
}

// canned per-trigger fallbacks used when LLM fails, guardrail fires, or
// trigger is unknown. Keep these short, generic, and demo-safe.
var canned = map[Trigger]string{
	TriggerOpen:   "The auction is officially open - get your bids ready.",
	TriggerSurge:  "The competition is heating up - the increments just jumped.",
	TriggerCold:   "The room has gone quiet - there is still time to take it back.",
	TriggerHammer: "Sold - congratulations to the winner.",
}

// HandlerFunc exposes the HTTP handler shape so the sidecar main.go can
// wire it directly. The LLM call itself is pluggable via the generator
// arg — tests inject a mock; prod injects the real Doubao client.
func HandlerFunc(generate Generator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !validTrigger(req.Trigger) {
			http.Error(w, "unknown trigger", http.StatusBadRequest)
			return
		}
		resp := generateWithGuardrail(req, generate)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// Generator is the pluggable LLM call. Tests inject a deterministic
// implementation; prod injects real Doubao.
type Generator func(req Request) (text string, err error)

// activeModel labels Response.ModelName. Select() flips it to the real model id
// when the Ark path is wired; the default keeps the mock label so existing
// behavior + tests are unchanged.
var activeModel = mockModelName

// Select returns the generator chosen by env. A real OpenAI-compatible client
// runs when LLM_API_KEY + LLM_MODEL are set - Volcengine Ark / Doubao by default,
// or any OpenAI-compatible server (Ollama + Qwen2.5 for the open-source path)
// via LLM_BASE_URL/LLM_MODEL. With no key it returns MockGenerator, so a box
// without creds keeps emitting canned-but-trigger-aware commentary. main.go
// wires the result; the guardrail + canned fallback wrap whichever is chosen.
func Select() Generator {
	cfg := llm.ConfigFromEnv("LLM", llm.DefaultArkBaseURL, "")
	if !cfg.Enabled() {
		activeModel = mockModelName
		return MockGenerator
	}
	activeModel = cfg.Model
	log.Printf("[auctioneer] real LLM enabled model=%s base=%s", cfg.Model, cfg.BaseURL)
	return arkGenerator(cfg)
}

// auctioneerSystem pins the commentary contract: ONE short spoken Chinese line,
// no URLs / phones / explicit money amounts / banned compliance words — so the
// model's output rarely trips failsGuardrail (and the guardrail still catches it
// when it does, falling back to canned text).
const auctioneerSystem = "You are the AI auctioneer of a live-streamed auction. Given the auction state, write ONE spoken-style English line " +
	"of at most 20 words that names the current situation and lifts the energy. Never include a URL, a phone number, a specific " +
	"currency amount, or claims such as \"guaranteed authentic\", \"100% genuine\", \"tenfold refund\", \"absolute lowest price\", " +
	"\"only one in existence\", or \"buyback at original price\". Output only the line itself, with no quotes and no prefix."

// arkGenerator adapts an llm.Config into a Generator. context.Background() is
// fine: llm.Complete bounds itself with cfg.Timeout, and the auctioneer call is
// already off the bid hot path (backend dispatches it in a goroutine).
func arkGenerator(cfg llm.Config) Generator {
	return func(req Request) (string, error) {
		return cfg.Complete(context.Background(), []llm.Message{
			llm.System(auctioneerSystem),
			llm.UserText(renderTriggerCtx(req)),
		}, llm.Options{MaxTokens: 96, Temperature: 0.9})
	}
}

// renderTriggerCtx describes the auction moment for the model WITHOUT currency
// symbols (so the model isn't tempted to echo a ¥ amount and trip the money
// guardrail). The guardrail is the backstop; this is the nudge.
func renderTriggerCtx(req Request) string {
	winner := req.Ctx.WinnerDisplayName
	if winner == "" {
		winner = "nobody yet"
	}
	switch req.Trigger {
	case TriggerOpen:
		return fmt.Sprintf("Scene=auction opening. Leader=%s. Open the session and remind everyone about the last-10-seconds anti-snipe extension.", winner)
	case TriggerSurge:
		return fmt.Sprintf("Scene=bidding heating up, increments coming faster. Leader=%s, extended %d time(s). Build the tension.", winner, req.Ctx.ExtendCount)
	case TriggerCold:
		return fmt.Sprintf("Scene=cold spell, quiet for %d seconds. Leader=%s. Push the room to bid back.", req.Ctx.SecondsSinceLastBid, winner)
	case TriggerHammer:
		return fmt.Sprintf("Scene=hammer, sold. Winner=%s. Announce the sale, congratulate them, and mention the sequence is on the chain.", winner)
	}
	return "Scene=auction in progress."
}

// MockGenerator returns canned-but-trigger-aware text in development.
// Includes the winner's name in surge/hammer to look LLM-y without
// actually calling an LLM. Production swaps this for a Doubao client.
func MockGenerator(req Request) (string, error) {
	winner := req.Ctx.WinnerDisplayName
	if winner == "" {
		winner = "SeaBreeze_2024"
	}
	switch req.Trigger {
	case TriggerOpen:
		return "We are open - " + winner + ", watch the clock.", nil
	case TriggerSurge:
		return winner + " jumps three steps at once - that is a serious bidder.", nil
	case TriggerCold:
		return fmt.Sprintf("Quiet for %ds - who is going to break the silence?", req.Ctx.SecondsSinceLastBid), nil
	case TriggerHammer:
		return "Hammer down - " + winner + " takes it; sequence on the chain.", nil
	}
	return "", errors.New("unknown trigger")
}

// generateWithGuardrail is the shared core: call the generator, apply
// the guardrail, fall back to canned text on any failure. Always returns
// a valid Response — never errors back to the caller (backend doesn't
// need to handle "AI failed" specially because we always have text).
func generateWithGuardrail(req Request, generate Generator) Response {
	text, err := generate(req)
	model := activeModel
	if err != nil {
		log.Printf("[auctioneer] generator failed trigger=%s err=%v · falling back", req.Trigger, err)
		return Response{
			Trigger:    req.Trigger,
			Commentary: canned[req.Trigger],
			Fallback:   true,
			ModelName:  model,
		}
	}
	if reason, bad := failsGuardrail(text); bad {
		log.Printf("[auctioneer] guardrail trigger=%s reason=%s text=%q · falling back", req.Trigger, reason, text)
		return Response{
			Trigger:    req.Trigger,
			Commentary: canned[req.Trigger],
			Fallback:   true,
			ModelName:  model,
		}
	}
	return Response{
		Trigger:    req.Trigger,
		Commentary: text,
		Fallback:   false,
		ModelName:  model,
	}
}

// failsGuardrail returns (reason, true) when text violates any rule.
// Caller swaps to canned fallback on a true return.
func failsGuardrail(text string) (string, bool) {
	if utf8.RuneCountInString(text) > maxTextLen {
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

func validTrigger(t Trigger) bool {
	switch t {
	case TriggerOpen, TriggerSurge, TriggerCold, TriggerHammer:
		return true
	}
	return false
}
