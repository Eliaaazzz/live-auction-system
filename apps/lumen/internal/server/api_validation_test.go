package server

import (
	"encoding/json"
	"net/http"
	"os"
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

func TestT2SecondPriceAuctionsExposeAuctionModeInSnapshot(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "Second Price Seller", "seller")
	if err != nil {
		t.Fatalf("dev login: %v", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatalf("create product: %v", err)
	}

	var created struct {
		AuctionID string `json:"auctionId"`
	}
	body := map[string]any{
		"productId": productID,
		"rules": model.Rules{
			StartPriceCents: 10000,
			IncrementCents:  1000,
			CapPriceCents:   1000000,
			DurationSec:     60,
			ExtendWindowSec: 10,
			ExtendSec:       10,
			AuctionMode:     model.AuctionModeSecondPrice,
		},
		"factsConfirmed": true,
	}
	if err := postJSON(hc, target+"/api/auctions", seller.Token, body, &created); err != nil {
		t.Fatalf("create auction: %v", err)
	}

	var snap model.RoomSnapshotData
	if err := getJSON(hc, target+"/api/auctions/"+created.AuctionID, &snap); err != nil {
		t.Fatalf("get auction snapshot: %v", err)
	}
	if snap.Rules == nil {
		t.Fatal("snapshot rules missing")
	}
	if got, want := snap.Rules.AuctionMode, model.AuctionModeSecondPrice; got != want {
		t.Fatalf("auctionMode=%q want=%q", got, want)
	}
}

func TestT2AuctionDefaultsExposeFirstPriceInSnapshot(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "Default Mode Seller", "seller")
	if err != nil {
		t.Fatalf("dev login: %v", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatalf("create product: %v", err)
	}

	var created struct {
		AuctionID string `json:"auctionId"`
	}
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId": productID,
		"rules": model.Rules{
			StartPriceCents: 10000,
			IncrementCents:  1000,
			CapPriceCents:   1000000,
			DurationSec:     60,
			ExtendWindowSec: 10,
			ExtendSec:       10,
			// intentionally omit auctionMode: contract default should be first_price.
		},
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatalf("create auction: %v", err)
	}

	var snap model.RoomSnapshotData
	if err := getJSON(hc, target+"/api/auctions/"+created.AuctionID, &snap); err != nil {
		t.Fatalf("get auction snapshot: %v", err)
	}
	if snap.Rules == nil {
		t.Fatal("snapshot rules missing")
	}
	if got, want := snap.Rules.AuctionMode, model.AuctionModeFirstPrice; got != want {
		t.Fatalf("auctionMode=%q want=%q", got, want)
	}
}
