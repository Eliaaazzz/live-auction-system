package server

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

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

func TestNormalizeCreateAuctionRulesTrimsAuctionMode(t *testing.T) {
	raw := json.RawMessage(`{
		"startPriceCents":"10000",
		"incrementCents":"1000",
		"durationSec":60,
		"auctionMode":" second_price "
	}`)
	rules, err := normalizeCreateAuctionRules(raw, model.Rules{})
	if err != nil {
		t.Fatalf("normalize auction rules: %v", err)
	}
	if rules.AuctionMode != model.AuctionModeSecondPrice {
		t.Fatalf("auctionMode=%q want=%q", rules.AuctionMode, model.AuctionModeSecondPrice)
	}
}

func TestHandleHealthAndVersionExposeBuildAndSchema(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}
	base := model.SchemaVersion

	var h, v map[string]any
	if err := getJSON(hc, target+"/healthz", &h); err != nil {
		t.Fatalf("healthz: %v", err)
	}
	if err := getJSON(hc, target+"/version", &v); err != nil {
		t.Fatalf("version: %v", err)
	}

	if got := h["status"]; got != "ok" {
		t.Fatalf("health payload status=%v want ok", got)
	}
	if got := v["wsSchema"]; got != float64(base) {
		t.Fatalf("version payload wsSchema=%v want %d", got, base)
	}
	if got := h["wsSchema"]; got != float64(base) {
		t.Fatalf("wsSchema=%v want %d", got, base)
	}

	build, ok := h["build"].(map[string]any)
	if !ok {
		t.Fatalf("build=%T want map[string]any", h["build"])
	}
	buildVersion, ok := v["build"].(map[string]any)
	if !ok {
		t.Fatalf("version build=%T want map[string]any", v["build"])
	}
	if rev, ok := build["revision"].(string); !ok || rev == "" {
		t.Fatalf("build.revision=%v want non-empty string", build["revision"])
	}
	if revV, ok := buildVersion["revision"].(string); !ok || revV == "" {
		t.Fatalf("version build.revision=%v want non-empty string", buildVersion["revision"])
	}
	if ts, ok := build["time"].(string); !ok || ts == "" {
		t.Fatalf("build.time=%v want non-empty string", build["time"])
	}
	if tsV, ok := buildVersion["time"].(string); !ok || tsV == "" {
		t.Fatalf("version build.time=%v want non-empty string", buildVersion["time"])
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

func TestT2SecondPriceAuctionsAllowWhitespaceModeInRawPayload(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	seller, err := devLogin(hc, target, "Whitespace Mode Seller", "seller")
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
		"rules": json.RawMessage(`{
			"startPriceCents":"10000",
			"incrementCents":"1000",
			"durationSec":60,
			"auctionMode":" second_price "
		}`),
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

type reserveAdvisorResponse struct {
	AuctionID         string  `json:"auctionId"`
	Status            string  `json:"status"`
	CurrentPriceCents string  `json:"currentPriceCents"`
	WinnerID          string  `json:"winnerId"`
	Advice            struct {
		MinBidCents string  `json:"minBidCents"`
		MaxBidCents string  `json:"maxBidCents"`
		Confidence  float64 `json:"confidence"`
		ReasonCode  string  `json:"reasonCode"`
	} `json:"advice"`
}

func TestReserveAdvisorReturnsNotLiveReasonForDraftAuction(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "Reserve Advisor Draft Seller", "seller")
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
		"rules": map[string]any{
			"startPriceCents": "10000",
			"incrementCents":  "1000",
			"capPriceCents":   "20000",
			"durationSec":     60,
		},
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatalf("create auction: %v", err)
	}

	var out reserveAdvisorResponse
	if err := getJSON(hc, target+"/api/auctions/"+created.AuctionID+"/reserve-advisor", &out); err != nil {
		t.Fatalf("get reserve advisor: %v", err)
	}
	if out.AuctionID != created.AuctionID {
		t.Fatalf("auctionId=%s want %s", out.AuctionID, created.AuctionID)
	}
	if got, want := out.Status, model.StateDraft; got != want {
		t.Fatalf("status=%s want %s", got, want)
	}
	if got := out.Advice.ReasonCode; got != "AUCTION_NOT_LIVE" {
		t.Fatalf("reasonCode=%q want AUCTION_NOT_LIVE", got)
	}
}

func TestReserveAdvisorProvidesLiveRangeAndConfidence(t *testing.T) {
	target := os.Getenv("TARGET")
	if target == "" {
		target, _ = startTestServer(t)
	}
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "Reserve Advisor Seller", "seller")
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
		"rules": map[string]any{
			"startPriceCents": "10000",
			"incrementCents":  "1000",
			"capPriceCents":   "20000",
			"durationSec":     60,
		},
		"factsConfirmed": true,
	}, &created); err != nil {
		t.Fatalf("create auction: %v", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+created.AuctionID+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+created.AuctionID+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		t.Fatalf("start: %v", err)
	}

	var out reserveAdvisorResponse
	if err := getJSON(hc, target+"/api/auctions/"+created.AuctionID+"/reserve-advisor", &out); err != nil {
		t.Fatalf("get reserve advisor: %v", err)
	}
	if got, want := out.Status, model.StateLive; got != want {
		t.Fatalf("status=%s want %s", got, want)
	}
	if got, want := out.Advice.MinBidCents, "11000"; got != want {
		t.Fatalf("minBidCents=%q want %q", got, want)
	}
	if got, want := out.Advice.MaxBidCents, "20000"; got != want {
		t.Fatalf("maxBidCents=%q want %q", got, want)
	}
	if got, want := out.Advice.ReasonCode, "OK_CAP"; got != want {
		t.Fatalf("reasonCode=%q want %q", got, want)
	}
	if out.Advice.Confidence < 0.5 {
		t.Fatalf("confidence=%v want >= 0.5", out.Advice.Confidence)
	}
}

func TestReserveAdvisorFromSnapshotReturnsNonLiveReason(t *testing.T) {
	got := reserveAdvisorFromSnapshot(model.RoomSnapshotData{Status: model.StateDraft})
	if got.ReasonCode != "AUCTION_NOT_LIVE" {
		t.Fatalf("ReasonCode=%q want AUCTION_NOT_LIVE", got.ReasonCode)
	}
	if got.Confidence != 0 {
		t.Fatalf("Confidence=%v want 0", got.Confidence)
	}
}

func TestReserveAdvisorFromSnapshotReturnsInvalidStepReason(t *testing.T) {
	got := reserveAdvisorFromSnapshot(model.RoomSnapshotData{
		Status: model.StateLive,
		Rules: &model.RoomSnapshotRules{
			StepCents: "0",
		},
	})
	if got.ReasonCode != "RULES_INVALID_STEP" {
		t.Fatalf("ReasonCode=%q want RULES_INVALID_STEP", got.ReasonCode)
	}
	if got.Confidence != 0 {
		t.Fatalf("Confidence=%v want 0", got.Confidence)
	}
}

func TestReserveAdvisorFromSnapshotReturnsCapConstrainedRange(t *testing.T) {
	got := reserveAdvisorFromSnapshot(model.RoomSnapshotData{
		Status:            model.StateLive,
		CurrentPriceCents: "9500",
		Rules: &model.RoomSnapshotRules{
			StepCents:   "2000",
			CapCents:    ptr("9000"),
		},
	})
	if got.ReasonCode != "OK_CAP" {
		t.Fatalf("ReasonCode=%q want OK_CAP", got.ReasonCode)
	}
	if got.MinBidCents != "9000" {
		t.Fatalf("MinBidCents=%q want 9000", got.MinBidCents)
	}
	if got.MaxBidCents != "9000" {
		t.Fatalf("MaxBidCents=%q want 9000", got.MaxBidCents)
	}
}

func ptr(s string) *string {
	return &s
}
