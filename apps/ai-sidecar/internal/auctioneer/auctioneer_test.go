package auctioneer

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── Guardrail unit tests · TC-T7-202 ───────────────────────────────

func TestGuardrail_OK(t *testing.T) {
	if reason, bad := failsGuardrail("We are open - SeaBreeze_2024, watch the clock."); bad {
		t.Fatalf("clean text marked bad: reason=%s", reason)
	}
}

func TestGuardrail_LengthTruncation(t *testing.T) {
	long := strings.Repeat("a", 81)
	reason, bad := failsGuardrail(long)
	if !bad || reason != "len" {
		t.Fatalf("expected len violation, got reason=%s bad=%v", reason, bad)
	}
}

func TestGuardrail_LengthBoundary(t *testing.T) {
	// Exactly 80 runes is OK; 81 is over.
	ok := strings.Repeat("a", 80)
	if _, bad := failsGuardrail(ok); bad {
		t.Fatal("80 runes should pass")
	}
	over := strings.Repeat("a", 81)
	if _, bad := failsGuardrail(over); !bad {
		t.Fatal("81 runes should fail")
	}
}

func TestGuardrail_BlocksURL(t *testing.T) {
	cases := []string{
		"go to https://evil.example",
		"visit www.scam.cn for deals",
		"http://nope click",
	}
	for _, c := range cases {
		if reason, bad := failsGuardrail(c); !bad || reason != "url" {
			t.Errorf("%q: expected url violation, got reason=%s bad=%v", c, reason, bad)
		}
	}
}

func TestGuardrail_BlocksPhone(t *testing.T) {
	if reason, bad := failsGuardrail("call 13912345678 now"); !bad || reason != "phone" {
		t.Fatalf("expected phone violation, got reason=%s bad=%v", reason, bad)
	}
	if reason, bad := failsGuardrail("contact +86 13900001111"); !bad || reason != "phone" {
		t.Fatalf("expected phone violation (intl), got reason=%s bad=%v", reason, bad)
	}
}

func TestGuardrail_BlocksFreeFormMoney(t *testing.T) {
	if reason, bad := failsGuardrail("Bid ¥99999 and take it now"); !bad || reason != "money" {
		t.Fatalf("expected money violation, got reason=%s bad=%v", reason, bad)
	}
	if reason, bad := failsGuardrail("just $50 today"); !bad || reason != "money" {
		t.Fatalf("expected money violation (USD), got reason=%s bad=%v", reason, bad)
	}
}

func TestGuardrail_BlocksBannedWords(t *testing.T) {
	cases := []struct {
		text string
		want string // expected reason prefix
	}{
		{"absolute lowest price, do not miss it", "banned:absolute lowest price"},
		{"only one in existence, gone forever", "banned:only one in existence"},
		{"a tenfold refund promise", "banned:tenfold refund"},
		{"100% guaranteed authentic piece", "banned:guaranteed authentic"},
	}
	for _, c := range cases {
		reason, bad := failsGuardrail(c.text)
		if !bad || reason != c.want {
			t.Errorf("%q: expected %s, got reason=%s bad=%v", c.text, c.want, reason, bad)
		}
	}
}

// ─── generateWithGuardrail · fallback paths · TC-T7-202/203 ─────────

func TestGenerate_FallsBackOnGeneratorError(t *testing.T) {
	req := Request{AuctionID: "auc_x", Trigger: TriggerOpen}
	gen := func(_ Request) (string, error) { return "", errors.New("llm down") }

	resp := generateWithGuardrail(req, gen)
	if !resp.Fallback {
		t.Fatal("expected fallback=true")
	}
	if resp.Commentary != canned[TriggerOpen] {
		t.Fatalf("expected canned open, got %q", resp.Commentary)
	}
}

func TestGenerate_FallsBackOnGuardrailViolation(t *testing.T) {
	// TC-T7-202: LLM returns banned word → fallback canned text + log.
	req := Request{AuctionID: "auc_x", Trigger: TriggerHammer}
	gen := func(_ Request) (string, error) {
		return "guaranteed authentic piece at the hammer price", nil
	}
	resp := generateWithGuardrail(req, gen)
	if !resp.Fallback {
		t.Fatal("expected fallback=true on banned-word violation")
	}
	if resp.Commentary != canned[TriggerHammer] {
		t.Fatalf("expected canned hammer, got %q", resp.Commentary)
	}
}

func TestGenerate_PassesThroughCleanText(t *testing.T) {
	req := Request{AuctionID: "auc_x", Trigger: TriggerSurge, Ctx: Ctx{WinnerDisplayName: "SeaBreeze_2024"}}
	resp := generateWithGuardrail(req, MockGenerator)
	if resp.Fallback {
		t.Fatal("clean text should not fall back")
	}
	if !strings.Contains(resp.Commentary, "SeaBreeze_2024") {
		t.Fatalf("expected winner name in surge text, got %q", resp.Commentary)
	}
}

// ─── HandlerFunc · TC-T7-201 contract test ──────────────────────────

func TestHandler_ReturnsExpectedShape(t *testing.T) {
	// 4 trigger calls; each response must conform to proto/ai-events.md
	// §POST /llm/auctioneer (Response shape).
	for _, trig := range []Trigger{TriggerOpen, TriggerSurge, TriggerCold, TriggerHammer} {
		t.Run(string(trig), func(t *testing.T) {
			body, _ := json.Marshal(Request{
				AuctionID: "auc_demo",
				Trigger:   trig,
				Ctx:       Ctx{CurrentPriceCents: "10000", WinnerDisplayName: "u_test"},
			})
			req := httptest.NewRequest("POST", "/llm/auctioneer", bytes.NewReader(body))
			rr := httptest.NewRecorder()

			HandlerFunc(MockGenerator).ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("got status %d", rr.Code)
			}
			var resp Response
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if resp.Trigger != trig {
				t.Fatalf("trigger mismatch: got %s", resp.Trigger)
			}
			if resp.Commentary == "" {
				t.Fatal("commentary must not be empty")
			}
			if resp.ModelName == "" {
				t.Fatal("modelName must not be empty")
			}
		})
	}
}

func TestHandler_RejectsUnknownTrigger(t *testing.T) {
	body, _ := json.Marshal(Request{AuctionID: "auc_demo", Trigger: "evil"})
	req := httptest.NewRequest("POST", "/llm/auctioneer", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	HandlerFunc(MockGenerator).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown trigger, got %d", rr.Code)
	}
}

func TestHandler_RejectsMalformedBody(t *testing.T) {
	req := httptest.NewRequest("POST", "/llm/auctioneer", strings.NewReader("not json"))
	rr := httptest.NewRecorder()
	HandlerFunc(MockGenerator).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed body, got %d", rr.Code)
	}
}
