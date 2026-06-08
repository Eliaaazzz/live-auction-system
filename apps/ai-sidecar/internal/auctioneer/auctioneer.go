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

// Compiled once at package init for hot-path use.
var (
	reURL   = regexp.MustCompile(`(?i)\b(https?://|www\.)\S+`)
	rePhone = regexp.MustCompile(`\b\d{11}\b|\b\+\d{1,3}[ -]?\d{4,}\b`)
	// Free-form money pattern: currency symbol followed by digits.
	// Tight to avoid matching legitimate auction prices in the canned
	// fallback (those are formatted by the backend, not LLM-generated).
	reMoney = regexp.MustCompile(`(¥|\$|元)\s*\d`)
)

// bannedWords mirrors compliance per spec. Production list lives in
// apps/ai-sidecar/internal/badwords.json (or a Chinese sensitive-word
// dict); this package ships a starter seed enforced by tests.
var bannedWords = []string{
	"绝对最低价",
	"仅此一件",
	"假一赔十",
	"保真",
	"百分百正品",
	"原价回收",
}

// canned per-trigger fallbacks used when LLM fails, guardrail fires, or
// trigger is unknown. Keep these short, generic, and demo-safe.
var canned = map[Trigger]string{
	TriggerOpen:   "拍卖正式开始 · 各位准备出价。",
	TriggerSurge:  "竞争升温 · 出价幅度明显加大。",
	TriggerCold:   "场内沉寂 · 还有机会反手抢回。",
	TriggerHammer: "落槌成交 · 恭喜得主。",
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
var activeModel = "mock-llm-T7"

// Select returns the generator chosen by env. A real OpenAI-compatible client
// runs when LLM_API_KEY + LLM_MODEL are set — Volcengine Ark / 豆包 by default,
// or any OpenAI-compatible server (Ollama + Qwen2.5 for the open-source path)
// via LLM_BASE_URL/LLM_MODEL. With no key it returns MockGenerator, so a box
// without creds keeps emitting canned-but-trigger-aware commentary. main.go
// wires the result; the guardrail + canned fallback wrap whichever is chosen.
func Select() Generator {
	cfg := llm.ConfigFromEnv("LLM", llm.DefaultArkBaseURL, "")
	if !cfg.Enabled() {
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
const auctioneerSystem = "你是抖音直播拍卖的 AI 主播。根据给定的拍卖状态，用一句口语化中文解说（不超过 35 字），" +
	"点出当前局势、带动气氛。严禁出现网址、电话、具体货币金额数字，以及" +
	"“保真/百分百正品/假一赔十/绝对最低价/仅此一件/原价回收”等词。只输出解说词本身，不要引号、不要前缀。"

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
		winner = "暂无领先者"
	}
	switch req.Trigger {
	case TriggerOpen:
		return fmt.Sprintf("场景=开拍。领先者=%s。请开场，提醒留意末 10 秒反狙击延时。", winner)
	case TriggerSurge:
		return fmt.Sprintf("场景=竞价升温，加价节奏明显加快。领先者=%s，已延时 %d 次。请渲染紧张感。", winner, req.Ctx.ExtendCount)
	case TriggerCold:
		return fmt.Sprintf("场景=冷场，已沉寂 %d 秒。领先者=%s。请激励观众反手出价。", req.Ctx.SecondsSinceLastBid, winner)
	case TriggerHammer:
		return fmt.Sprintf("场景=落槌成交。得主=%s。请宣布成交并恭喜，提到编号已上链。", winner)
	}
	return "场景=拍卖进行中。"
}

// MockGenerator returns canned-but-trigger-aware text in development.
// Includes the winner's name in surge/hammer to look LLM-y without
// actually calling an LLM. Production swaps this for a Doubao client.
func MockGenerator(req Request) (string, error) {
	winner := req.Ctx.WinnerDisplayName
	if winner == "" {
		winner = "海风_2024"
	}
	switch req.Trigger {
	case TriggerOpen:
		return "开拍 · " + winner + " 留意倒计时，机会就在前 10 秒。", nil
	case TriggerSurge:
		return winner + " 一跃 +3 档 · 这是真的玩家。", nil
	case TriggerCold:
		return fmt.Sprintf("沉寂 %ds · 谁来打破这场静默？", req.Ctx.SecondsSinceLastBid), nil
	case TriggerHammer:
		return "落槌 · " + winner + " 拿下，编号已上链。", nil
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
