package advisor

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Edge cases contributed by fariZzzz's #116 review (review.md boundary pass).

// Sealed summary present but max unusable → generator errors → handler still
// returns a valid advisory fallback (200, not 500/panic).
func TestEdge_SealedInvalidMax_FallsBack(t *testing.T) {
	body, _ := json.Marshal(Request{Market: Market{SealedSummary: &SealedSummary{Count: 5, MaxCents: "abc"}}})
	rr := httptest.NewRecorder()
	HandlerFunc(MockGenerator).ServeHTTP(rr, httptest.NewRequest("POST", "/llm/recommend", bytes.NewReader(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var resp Response
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.AdvisoryOnly || !resp.Fallback || resp.Disclaimer == "" {
		t.Fatalf("invalid sealed max should yield advisory fallback, got %+v", resp)
	}
}

// Rationale length boundary — exactly maxRationaleLen passes; +1 fails.
func TestEdge_RationaleLenBoundary(t *testing.T) {
	if _, bad := failsGuardrail(strings.Repeat("a", maxRationaleLen)); bad {
		t.Errorf("exactly %d runes must PASS", maxRationaleLen)
	}
	if _, bad := failsGuardrail(strings.Repeat("a", maxRationaleLen+1)); !bad {
		t.Errorf("%d runes must FAIL", maxRationaleLen+1)
	}
}

// A huge-but-valid int64 cents value clamps to maxSaneCents, so downstream
// arithmetic (×13/10, ×80/100) stays positive — no int64 overflow into garbage.
func TestEdge_HugeCentsClampedNoOverflow(t *testing.T) {
	if got := parseCents("9000000000000000000"); got != maxSaneCents {
		t.Fatalf("huge value should clamp to maxSaneCents=%d, got %d", maxSaneCents, got)
	}
	adv, err := MockGenerator(Request{Item: Item{EstValueCents: "9000000000000000000"}})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.HasPrefix(adv.StartPriceCents, "-") || strings.HasPrefix(adv.ReserveCents, "-") {
		t.Fatalf("clamped huge cents must stay positive: start=%q reserve=%q", adv.StartPriceCents, adv.ReserveCents)
	}
}
