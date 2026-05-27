package server

// ai_events_test.go — schema contract tests for ai-sidecar responses.
//
// Per proto/ai-events.md, this file pins the validator behavior so a
// regression in either:
//
//	(a) the sidecar (e.g. real Doubao response shape drifts) — caught by
//	    the VLM golden fixture, which IS the same JSON the mock sidecar
//	    returns (apps/ai-sidecar/cmd/sidecar/main.go factsDraft); for the
//	    auctioneer path, fixtures match PR #74's wire shape
//
//	(b) the validator (e.g. someone loosens a pattern, removes a required
//	    field) — caught by the negative cases
//
// shows up here at `go test` time, before it reaches a real auction room.
//
// All tests are pure (no Redis, no MySQL, no HTTP) — runs in <1ms, no skip
// in CI per the project's --- SKIP guard.

import (
	"strings"
	"testing"
)

// ─── §1 VLM facts /facts/draft ───────────────────────────────────────

// goldenVLMResponse is byte-identical to what apps/ai-sidecar mock returns.
// If the sidecar mock ever drifts, regenerate by curling the running mock
// and pasting the response here.
var goldenVLMResponse = []byte(`{
  "facts": [
    { "field": "category", "value": "watch", "confidence": 0.91, "highRisk": false },
    { "field": "authenticity", "value": "unverified", "confidence": 0.0, "highRisk": true }
  ],
  "highRiskFieldsDisclaimer": "高风险字段为卖家声明，AI 未验证。",
  "modelName": "mock-vlm-T1"
}`)

// TC-T7-VLM-401 — the mock response (the only shape that exists today)
// MUST validate. Any change to the sidecar's mock that breaks this is a
// contract regression caught by `go test`.
func TestValidateVLMFactsResponse_GoldenMock(t *testing.T) {
	if err := ValidateVLMFactsResponse(goldenVLMResponse); err != nil {
		t.Fatalf("golden mock VLM response should validate, got: %v", err)
	}
}

// TC-T7-VLM-402 — highRiskFieldsDisclaimer is the only ALWAYS-required
// field per §1 (empty facts OK, but disclaimer must always render so the
// seller-declared caveat shows even when VLM declined to extract).
func TestValidateVLMFactsResponse_MissingDisclaimer(t *testing.T) {
	body := []byte(`{
		"facts": [{"field":"x","value":"y","confidence":0.5,"highRisk":false}],
		"highRiskFieldsDisclaimer": "",
		"modelName": "mock-vlm-T1"
	}`)
	err := ValidateVLMFactsResponse(body)
	if err == nil {
		t.Fatal("expected error for empty disclaimer, got nil")
	}
	if !strings.Contains(err.Error(), "highRiskFieldsDisclaimer") {
		t.Fatalf("error should mention highRiskFieldsDisclaimer, got: %v", err)
	}
}

// TC-T7-VLM-403 — forward-compat: a T7 sidecar that adds new fields
// (e.g. tokenUsage, modelVersion) MUST not break T6 validation. The
// validator parses with DisallowUnknownFields OFF by design.
func TestValidateVLMFactsResponse_ForwardCompatExtraField(t *testing.T) {
	body := []byte(`{
		"facts": [{"field":"x","value":"y","confidence":0.5,"highRisk":false}],
		"highRiskFieldsDisclaimer": "高风险字段为卖家声明，AI 未验证。",
		"modelName": "doubao-vlm-T7",
		"tokenUsage": 1234,
		"modelVersion": "v2.0.0"
	}`)
	if err := ValidateVLMFactsResponse(body); err != nil {
		t.Fatalf("forward-compat extra fields should not error: %v", err)
	}
}

// TC-T7-VLM-404 — confidence is a probability; outside [0,1] is a model
// bug or a corrupt response. Reject so the UI doesn't render a 150%-
// confident "fact" as authoritative.
func TestValidateVLMFactsResponse_ConfidenceOutOfRange(t *testing.T) {
	body := []byte(`{
		"facts": [{"field":"x","value":"y","confidence":1.5,"highRisk":false}],
		"highRiskFieldsDisclaimer": "...",
		"modelName": "mock-vlm-T1"
	}`)
	err := ValidateVLMFactsResponse(body)
	if err == nil {
		t.Fatal("expected error for confidence > 1.0, got nil")
	}
	if !strings.Contains(err.Error(), "confidence") {
		t.Fatalf("error should mention confidence, got: %v", err)
	}
}

// TC-T7-VLM-405 — empty facts is intentional (VLM declined to extract).
// The disclaimer + modelName still must be present so the UI can show
// the "no facts drafted, please add manually" + "seller-declared caveat".
func TestValidateVLMFactsResponse_EmptyFactsAllowed(t *testing.T) {
	body := []byte(`{
		"facts": [],
		"highRiskFieldsDisclaimer": "高风险字段为卖家声明，AI 未验证。",
		"modelName": "mock-vlm-T1"
	}`)
	if err := ValidateVLMFactsResponse(body); err != nil {
		t.Fatalf("empty facts with disclaimer should validate, got: %v", err)
	}
}

// TC-T7-VLM-406 — required field gaps (field/value empty) per §1.
// Table-driven so a future sidecar quirk is easy to encode.
func TestValidateVLMFactsResponse_RequiredFieldGaps(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSub string
	}{
		{
			name:    "missing modelName",
			body:    `{"facts":[],"highRiskFieldsDisclaimer":"x","modelName":""}`,
			wantSub: "modelName",
		},
		{
			name:    "empty field",
			body:    `{"facts":[{"field":"","value":"y","confidence":0.5,"highRisk":false}],"highRiskFieldsDisclaimer":"x","modelName":"m"}`,
			wantSub: "field",
		},
		{
			name:    "empty value",
			body:    `{"facts":[{"field":"x","value":"","confidence":0.5,"highRisk":false}],"highRiskFieldsDisclaimer":"x","modelName":"m"}`,
			wantSub: "value",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateVLMFactsResponse([]byte(c.body))
			if err == nil {
				t.Fatalf("expected error for %s, got nil", c.name)
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Fatalf("error should mention %q, got: %v", c.wantSub, err)
			}
		})
	}
}

// ─── §2 LLM auctioneer (defense-in-depth re-validator) ───────────────
//
// Wire spec owned by PR #74 (apps/ai-sidecar/internal/auctioneer/). These
// tests pin the backend re-validator behavior — sidecar guardrail catches
// bad output at source; this layer catches it at the cross-process trust
// boundary. Test fixtures match PR #74's response shape exactly.

// TC-T7-AUC-501 / 507 — boundary + happy-path per trigger.
func TestValidateAuctioneerResponse_AllTriggersHappyPath(t *testing.T) {
	for _, trig := range []string{"open", "surge", "cold", "hammer"} {
		t.Run(trig, func(t *testing.T) {
			body := []byte(`{"trigger":"` + trig + `","commentary":"全场起拍 · 雨过天晴","fallback":false,"modelName":"mock-llm-T7"}`)
			if err := ValidateAuctioneerResponse(body); err != nil {
				t.Fatalf("trigger=%s happy path should validate, got: %v", trig, err)
			}
		})
	}
}

// TC-T7-AUC-501 — boundary: exactly 80 runes is the cap, must pass.
func TestValidateAuctioneerResponse_BoundaryExactly80(t *testing.T) {
	// 80 Chinese chars (each 1 rune, 3 bytes UTF-8). Pad with simple ASCII
	// for readability of the assertion.
	text := strings.Repeat("一", 80)
	if r := []rune(text); len(r) != 80 {
		t.Fatalf("test setup broken — want 80 runes, got %d", len(r))
	}
	body := []byte(`{"trigger":"open","commentary":"` + text + `","fallback":false,"modelName":"m"}`)
	if err := ValidateAuctioneerResponse(body); err != nil {
		t.Fatalf("80-rune text should be at boundary (pass), got: %v", err)
	}
}

// TC-T7-AUC-502 — boundary: 81 runes exceeds cap, must fail.
func TestValidateAuctioneerResponse_Length81Fails(t *testing.T) {
	text := strings.Repeat("一", 81)
	body := []byte(`{"trigger":"open","commentary":"` + text + `","fallback":false,"modelName":"m"}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for 81-rune text, got nil")
	}
	if !strings.Contains(err.Error(), "length") {
		t.Fatalf("error should mention length, got: %v", err)
	}
}

// TC-T7-AUC-503 — URL pattern: any http(s) link triggers reject.
func TestValidateAuctioneerResponse_RejectsURL(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"快上 https://example.com 抢","fallback":false,"modelName":"m"}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for URL in text, got nil")
	}
	if !strings.Contains(err.Error(), "URL") {
		t.Fatalf("error should mention URL, got: %v", err)
	}
}

// TC-T7-AUC-504 — phone pattern: catches prompt-injection-induced contact-
// number leaks (sometimes seen when description field is jailbroken).
func TestValidateAuctioneerResponse_RejectsPhone(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"联系 13800138000 出价","fallback":false,"modelName":"m"}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for phone in text, got nil")
	}
	if !strings.Contains(err.Error(), "phone") {
		t.Fatalf("error should mention phone, got: %v", err)
	}
}

// TC-T7-AUC-505 — currency pattern: prevent text from naming an
// alternative price (which would mislead buyers). The auctioneer should
// describe pacing / urgency, not echo numeric amounts. Three forms
// covered per @fariZzzz #73 B1 review: ¥-prefix, $-prefix (English),
// 元-suffix (Chinese yuan written out).
func TestValidateAuctioneerResponse_RejectsCurrency(t *testing.T) {
	cases := []string{
		"已达 ¥138,800 继续",   // ¥ prefix
		"市价 50000元 起拍",     // 元 suffix (Chinese yuan written out)
		"约值 1万元 左右",        // 万 suffix
		"worth $500 today", // $ prefix (LLM English fallback)
	}
	for _, text := range cases {
		t.Run(text, func(t *testing.T) {
			body := []byte(`{"trigger":"surge","commentary":"` + text + `","fallback":false,"modelName":"m"}`)
			err := ValidateAuctioneerResponse(body)
			if err == nil {
				t.Fatalf("expected error for currency in %q, got nil", text)
			}
			if !strings.Contains(err.Error(), "currency") {
				t.Fatalf("error should mention currency for %q, got: %v", text, err)
			}
		})
	}
}

// TC-T7-AUC-506 — trigger must be one of the closed set. Unknown trigger
// indicates either a sidecar bug or a schema-drift across versions.
func TestValidateAuctioneerResponse_RejectsUnknownTrigger(t *testing.T) {
	body := []byte(`{"trigger":"hype","commentary":"x","fallback":false,"modelName":"m"}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for unknown trigger, got nil")
	}
	if !strings.Contains(err.Error(), "trigger") {
		t.Fatalf("error should mention trigger, got: %v", err)
	}
}

// TC-T7-AUC-508 — empty text string (sidecar returned nothing useful).
// This is a sidecar bug, not a valid empty-string case — reject so the
// fallback path fires.
func TestValidateAuctioneerResponse_RejectsEmpty(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"","fallback":false,"modelName":"m"}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for empty text, got nil")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Fatalf("error should mention empty, got: %v", err)
	}
}

// TC-T7-AUC-509 — modelName missing. Required so logs can attribute the
// text to a specific model version when offline-reviewing.
func TestValidateAuctioneerResponse_RejectsMissingModelName(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"x","fallback":false,"modelName":""}`)
	err := ValidateAuctioneerResponse(body)
	if err == nil {
		t.Fatal("expected error for missing modelName, got nil")
	}
	if !strings.Contains(err.Error(), "modelName") {
		t.Fatalf("error should mention modelName, got: %v", err)
	}
}

// TC-T7-AUC-510 — forward-compat: T7+ sidecar may add fields (latencyMs,
// promptTokens, etc.). Validator must tolerate unknown fields.
func TestValidateAuctioneerResponse_ForwardCompatExtraField(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"x","fallback":false,"modelName":"m","latencyMs":420,"promptTokens":50}`)
	if err := ValidateAuctioneerResponse(body); err != nil {
		t.Fatalf("forward-compat extra fields should not error: %v", err)
	}
}

// TC-T7-AUC-511 — fallback=true responses (sidecar swapped in canned text)
// MUST still validate — backend should NOT reject fallback responses,
// since fallback IS the safety-net path. The Fallback bool informs the
// frontend (auctioneerFallback in store) for UX styling, not for backend
// gating.
func TestValidateAuctioneerResponse_FallbackTrueAccepted(t *testing.T) {
	body := []byte(`{"trigger":"open","commentary":"开拍 · 出价踊跃","fallback":true,"modelName":"static-fallback"}`)
	if err := ValidateAuctioneerResponse(body); err != nil {
		t.Fatalf("fallback=true response should validate, got: %v", err)
	}
}
