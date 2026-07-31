package auctioneer

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/llm"
)

// arkGenerator drives a real OpenAI-compatible round-trip (httptest standing in
// for Ark/Doubao) and the full guardrail wrapper turns it into a Response.
func TestArkGenerator_RoundTripThroughGuardrail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"We are open - watch for the last-ten-seconds anti-snipe extension!"}}]}`))
	}))
	defer srv.Close()

	gen := arkGenerator(llm.Config{BaseURL: srv.URL, APIKey: "k", Model: "ep-test"})
	resp := generateWithGuardrail(Request{Trigger: TriggerOpen, Ctx: Ctx{WinnerDisplayName: "SeaBreeze_2024"}}, gen)
	if resp.Fallback {
		t.Fatalf("clean model output must not fall back: %+v", resp)
	}
	if !strings.Contains(resp.Commentary, "anti-snipe") {
		t.Fatalf("model commentary not returned: %q", resp.Commentary)
	}
}

// A model that returns a guardrail-violating line (explicit money) must be
// swapped for the canned fallback — the real path doesn't weaken compliance.
func TestArkGenerator_GuardrailStillCatchesBadModelOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Bid now! Down ¥5000, the absolute lowest price!"}}]}`))
	}))
	defer srv.Close()

	gen := arkGenerator(llm.Config{BaseURL: srv.URL, APIKey: "k", Model: "ep-test"})
	resp := generateWithGuardrail(Request{Trigger: TriggerSurge}, gen)
	if !resp.Fallback {
		t.Fatal("money + banned-word output must trip the guardrail → fallback")
	}
	if resp.Commentary != canned[TriggerSurge] {
		t.Fatalf("expected canned surge fallback, got %q", resp.Commentary)
	}
}

// Select with no creds keeps the mock generator (default-safe).
func TestSelect_NoCredsKeepsMock(t *testing.T) {
	t.Setenv("LLM_API_KEY", "")
	t.Setenv("LLM_MODEL", "")
	gen := Select()
	out, err := gen(Request{Trigger: TriggerOpen})
	if err != nil {
		t.Fatal(err)
	}
	// MockGenerator is trigger-aware and never errors on a valid trigger.
	if out == "" {
		t.Fatal("mock generator should produce text")
	}
}

func TestSelect_NoCredsResetsModelName(t *testing.T) {
	t.Setenv("LLM_API_KEY", "k")
	t.Setenv("LLM_MODEL", "ep-real")
	_ = Select()
	if activeModel != "ep-real" {
		t.Fatalf("activeModel=%q want ep-real after real Select", activeModel)
	}

	t.Setenv("LLM_API_KEY", "")
	t.Setenv("LLM_MODEL", "")
	gen := Select()
	resp := generateWithGuardrail(Request{Trigger: TriggerOpen}, gen)
	if resp.ModelName != mockModelName {
		t.Fatalf("ModelName=%q want %q after no-creds Select", resp.ModelName, mockModelName)
	}
}

func TestRenderTriggerCtx_NoCurrencySymbols(t *testing.T) {
	// The context we hand the model must not contain a currency symbol followed by a digit, so the model
	// isn't primed to echo a money amount that the guardrail would reject.
	for _, tr := range []Trigger{TriggerOpen, TriggerSurge, TriggerCold, TriggerHammer} {
		s := renderTriggerCtx(Request{Trigger: tr, Ctx: Ctx{WinnerDisplayName: "Lu_LU", ExtendCount: 2, SecondsSinceLastBid: 7}})
		if reMoney.MatchString(s) {
			t.Fatalf("trigger %s ctx contains a money pattern: %q", tr, s)
		}
		if s == "" {
			t.Fatalf("trigger %s produced empty ctx", tr)
		}
	}
}
