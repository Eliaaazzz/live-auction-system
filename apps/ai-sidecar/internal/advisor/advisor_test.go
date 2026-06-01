package advisor

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── HandlerFunc contract ────────────────────────────────────────────

func TestHandler_AdvisoryShape(t *testing.T) {
	body, _ := json.Marshal(Request{
		AuctionID: "auc_demo",
		Item:      Item{Category: "jewelry", EstValueCents: "10000000"},
		Market:    Market{OnlineViewers: 50, HistoricalSoldCents: []string{"9000000", "11000000"}},
	})
	req := httptest.NewRequest("POST", "/llm/recommend", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	HandlerFunc(MockGenerator).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d", rr.Code)
	}
	var resp Response
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.AdvisoryOnly {
		t.Fatal("advisoryOnly must be true (non-adjudicating)")
	}
	if resp.Disclaimer == "" {
		t.Fatal("disclaimer must always be present")
	}
	if resp.ModelName == "" {
		t.Fatal("modelName must be set")
	}
	if resp.StartPriceCents == "" || resp.StepCents == "" {
		t.Fatalf("expected numeric suggestions, got start=%q step=%q", resp.StartPriceCents, resp.StepCents)
	}
}

func TestHandler_RejectsMalformedBody(t *testing.T) {
	req := httptest.NewRequest("POST", "/llm/recommend", strings.NewReader("not json"))
	rr := httptest.NewRecorder()
	HandlerFunc(MockGenerator).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed body, got %d", rr.Code)
	}
}

// ─── non-adjudication + fallback invariants ──────────────────────────

func TestRecommend_AlwaysAdvisoryAndNeverErrors(t *testing.T) {
	// Even when the generator errors, the response is a valid advisory with
	// disclaimer + fallback=true: the seller UI always gets something usable
	// and the AI failure is silent (mirrors auctioneer's fallback contract).
	resp := recommendWithGuardrail(Request{AuctionID: "auc_x"}, func(Request) (Advice, error) {
		return Advice{}, errors.New("model down")
	})
	if !resp.AdvisoryOnly || !resp.Fallback {
		t.Fatalf("expected advisoryOnly+fallback on generator error, got %+v", resp)
	}
	if resp.Disclaimer == "" {
		t.Fatal("disclaimer must survive fallback")
	}
	// PDGGK #116: fallback must still carry a complete, non-zero suggestion so
	// downstream never sees missing numeric fields — even with no input signal.
	for _, f := range []struct{ name, v string }{
		{"start", resp.StartPriceCents}, {"step", resp.StepCents}, {"reserve", resp.ReserveCents},
	} {
		if f.v == "" || f.v == "0" {
			t.Errorf("fallback %s must be non-empty/non-zero, got %q", f.name, f.v)
		}
	}
}

func TestRecommend_GuardrailSwapsRationaleKeepsNumbers(t *testing.T) {
	// A rationale that trips the guardrail (banned words) is replaced by the
	// safe canned rationale; the numeric advice still flows through unchanged.
	resp := recommendWithGuardrail(Request{Item: Item{EstValueCents: "10000000"}}, func(Request) (Advice, error) {
		return Advice{
			Mode: ModeOpen, StartPriceCents: "6000000", StepCents: "100000",
			ReserveCents: "8000000", Rationale: "保真 · 绝对最低价",
		}, nil
	})
	if resp.Rationale != safeRationale {
		t.Fatalf("expected safe rationale swap, got %q", resp.Rationale)
	}
	if resp.StartPriceCents != "6000000" {
		t.Fatalf("numeric advice should survive the guardrail swap, got %q", resp.StartPriceCents)
	}
}

func TestRecommend_NormalizesUnknownMode(t *testing.T) {
	resp := recommendWithGuardrail(Request{}, func(Request) (Advice, error) {
		return Advice{Mode: "WILD", StartPriceCents: "1", StepCents: "1", Rationale: "ok"}, nil
	})
	if resp.RecommendedMode != ModeOpen {
		t.Fatalf("unknown mode should normalize to OPEN, got %s", resp.RecommendedMode)
	}
}

// ─── MockGenerator decision logic (issue #111 §6) ────────────────────

func TestMock_SealedOutlier_RecommendsEarlyAccept(t *testing.T) {
	adv, err := MockGenerator(Request{
		Market: Market{SealedSummary: &SealedSummary{
			Count: 12, MaxCents: "13000000", SecondCents: "9000000", MedianCents: "9500000",
		}},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.Contains(adv.Rationale, "直接成交") {
		t.Fatalf("top bid far above pack → expected early-accept rationale, got %q", adv.Rationale)
	}
}

func TestMock_SealedCluster_RecommendsOpenClimb(t *testing.T) {
	adv, err := MockGenerator(Request{
		Market: Market{SealedSummary: &SealedSummary{
			Count: 30, MaxCents: "10200000", SecondCents: "10000000", MedianCents: "9800000",
		}},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(adv.Rationale, "直接成交") {
		t.Fatalf("tight cluster should NOT advise early accept, got %q", adv.Rationale)
	}
}

func TestMock_SealedSingleBid_AnchorsOnMax(t *testing.T) {
	// One sealed bid → second = median = 0. Must NOT anchor on 0; floor falls
	// back to max (PDGGK #116). Not an early-accept (no second to compare).
	adv, err := MockGenerator(Request{
		Market: Market{SealedSummary: &SealedSummary{Count: 1, MaxCents: "9000000"}},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if adv.StartPriceCents != "9000000" || adv.ReserveCents != "9000000" {
		t.Fatalf("single sealed bid should anchor on max, got start=%q reserve=%q", adv.StartPriceCents, adv.ReserveCents)
	}
	if strings.Contains(adv.Rationale, "直接成交") {
		t.Fatalf("single bid (no second) should not be early-accept, got %q", adv.Rationale)
	}
}

func TestMock_ManyViewers_SuggestsSealedWarmup(t *testing.T) {
	adv, err := MockGenerator(Request{
		Item:   Item{EstValueCents: "10000000"},
		Market: Market{OnlineViewers: 500},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if adv.Mode != ModeSealedThenOpen {
		t.Fatalf("many viewers → expected SEALED_THEN_OPEN recommendation, got %s", adv.Mode)
	}
}

func TestMock_NoSignal_Errors(t *testing.T) {
	if _, err := MockGenerator(Request{}); err == nil {
		t.Fatal("expected error when there is no usable price signal")
	}
}

// Every mock rationale must itself pass the guardrail (no false self-trips).
func TestMock_RationalesAreGuardrailClean(t *testing.T) {
	reqs := []Request{
		{Item: Item{EstValueCents: "10000000"}, Market: Market{OnlineViewers: 50}},
		{Item: Item{EstValueCents: "10000000"}, Market: Market{OnlineViewers: 500}},
		{Market: Market{SealedSummary: &SealedSummary{Count: 5, MaxCents: "13000000", SecondCents: "9000000", MedianCents: "9500000"}}},
		{Market: Market{SealedSummary: &SealedSummary{Count: 5, MaxCents: "10200000", SecondCents: "10000000", MedianCents: "9800000"}}},
	}
	for i, r := range reqs {
		adv, err := MockGenerator(r)
		if err != nil {
			t.Fatalf("case %d err: %v", i, err)
		}
		if reason, bad := failsGuardrail(adv.Rationale); bad {
			t.Errorf("case %d rationale trips guardrail (%s): %q", i, reason, adv.Rationale)
		}
	}
}

// ─── guardrail unit checks ───────────────────────────────────────────

func TestGuardrail_BlocksUnsafeRationale(t *testing.T) {
	cases := map[string]string{
		"url":    "见 https://evil.example 详情",
		"phone":  "联系 13912345678",
		"money":  "底价 ¥99999 成交",
		"banned": "保真 精品",
		"len":    strings.Repeat("一", 81),
	}
	for want, text := range cases {
		reason, bad := failsGuardrail(text)
		if !bad || reason != want && !strings.HasPrefix(reason, want) {
			t.Errorf("%q: expected %s violation, got reason=%s bad=%v", text, want, reason, bad)
		}
	}
}
