package server

import (
	"encoding/json"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestValidateConfirmedFactsPayload(t *testing.T) {
	t.Run("valid payload", func(t *testing.T) {
		raw := json.RawMessage(`{
			"version": 1,
			"highRiskFieldsDisclaimer": "demo",
			"facts": [
				{
					"field": "brand",
					"label": "品牌",
					"value": "Patek Philippe",
					"status": "confirmed",
					"confidence": 0.99,
					"highRisk": false
				},
				{
					"field": "specs",
					"label": "参数",
					"value": "40mm",
					"status": "edited"
				}
			]
		}`)
		if err := validateConfirmedFactsPayload(raw); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	for name, tc := range map[string]struct {
		raw  json.RawMessage
		want string
	}{
		"empty object": {
			raw:  json.RawMessage(`{}`),
			want: "invalid confirmedFacts payload",
		},
		"missing facts": {
			raw:  json.RawMessage(`{"version":1}`),
			want: "invalid confirmedFacts payload",
		},
		"non-object": {
			raw:  json.RawMessage(`[]`),
			want: "invalid confirmedFacts payload",
		},
		"empty facts": {
			raw:  json.RawMessage(`{"facts":[]}`),
			want: "invalid confirmedFacts payload",
		},
		"bad fact status": {
			raw: json.RawMessage(`{
				"facts": [{"field":"brand","label":"品牌","value":"Patek","status":"pending"}]
			}`),
			want: "invalid confirmedFacts payload",
		},
		"value non-string": {
			raw: json.RawMessage(`{
				"facts": [{"field":"brand","label":"品牌","value":123,"status":"confirmed"}]
			}`),
			want: "invalid confirmedFacts payload",
		},
		"highRisk not bool": {
			raw: json.RawMessage(`{
				"facts": [{"field":"brand","label":"品牌","value":"Patek","status":"confirmed","highRisk":"false"}]
			}`),
			want: "invalid confirmedFacts payload",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateConfirmedFactsPayload(tc.raw); err == nil {
				t.Fatalf("want error")
			} else if err.Error() != tc.want {
				t.Fatalf("err=%q want=%q", err.Error(), tc.want)
			}
		})
	}
}

func TestNormalizeCreateAuctionRulesSupportsLegacyFormFields(t *testing.T) {
	raw := json.RawMessage(`{
		"startCents":"12000000",
		"stepCents":"500000",
		"reserveCents":"10000000",
		"capCents":null,
		"durationMs":1800000,
		"antiSnipeWindowMs":10000,
		"maxExtensions":8,
		"auctionMode":"second_price"
	}`)
	rules, err := normalizeCreateAuctionRules(raw, model.Rules{})
	if err != nil {
		t.Fatalf("normalize legacy rules: %v", err)
	}
	if got, want := rules.StartPriceCents, model.Cents(12000000); got != want {
		t.Fatalf("startPriceCents=%d want=%d", got, want)
	}
	if got, want := rules.IncrementCents, model.Cents(500000); got != want {
		t.Fatalf("incrementCents=%d want=%d", got, want)
	}
	if got, want := rules.DurationSec, int64(1800); got != want {
		t.Fatalf("durationSec=%d want=%d", got, want)
	}
	if got, want := rules.ExtendWindowSec, int64(10); got != want {
		t.Fatalf("extendWindowSec=%d want=%d", got, want)
	}
	if got, want := rules.ExtendSec, int64(30); got != want {
		t.Fatalf("extendSec=%d want=%d", got, want)
	}
	if got, want := rules.MaxExtensions, int64(8); got != want {
		t.Fatalf("maxExtensions=%d want=%d", got, want)
	}
	if rules.AuctionMode != model.AuctionModeSecondPrice {
		t.Fatalf("auctionMode=%q want=%q", rules.AuctionMode, model.AuctionModeSecondPrice)
	}
}

func TestNormalizeCreateAuctionRulesPrefersCanonicalFields(t *testing.T) {
	raw := json.RawMessage(`{
		"startPriceCents":"12000000",
		"startCents":"1",
		"incrementCents":1000000,
		"stepCents":"999",
		"durationSec":120,
		"durationMs":90000,
		"extendWindowSec":9,
		"extendSec":15,
		"antiSnipeWindowMs":10000
	}`)
	var baseline model.Rules
	rules, err := normalizeCreateAuctionRules(raw, baseline)
	if err != nil {
		t.Fatalf("normalize canonical+legacy rules: %v", err)
	}
	if got, want := rules.StartPriceCents, model.Cents(12000000); got != want {
		t.Fatalf("startPriceCents=%d want=%d", got, want)
	}
	if got, want := rules.IncrementCents, model.Cents(1000000); got != want {
		t.Fatalf("incrementCents=%d want=%d", got, want)
	}
	if got, want := rules.DurationSec, int64(120); got != want {
		t.Fatalf("durationSec=%d want=%d", got, want)
	}
	if got, want := rules.ExtendWindowSec, int64(9); got != want {
		t.Fatalf("extendWindowSec=%d want=%d", got, want)
	}
	if got, want := rules.ExtendSec, int64(15); got != want {
		t.Fatalf("extendSec=%d want=%d", got, want)
	}
}

func TestNormalizeCreateAuctionRulesRejectsMsFieldsWithoutSecondGranularity(t *testing.T) {
	t.Run("durationMs", func(t *testing.T) {
		_, err := normalizeCreateAuctionRules(json.RawMessage(`{"durationMs":1500}`), model.Rules{})
		if err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("antiSnipeWindowMs", func(t *testing.T) {
		_, err := normalizeCreateAuctionRules(json.RawMessage(`{"antiSnipeWindowMs":1750}`), model.Rules{})
		if err == nil {
			t.Fatal("expected error")
		}
	})
	_, err := normalizeCreateAuctionRules(json.RawMessage(`{"durationMs":1200000}`), model.Rules{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
