package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestPrequalifyRecommendationAndSpawnFormalUseSealedAggregate(t *testing.T) {
	target, srv := startTestServer(t)
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "Prequal Seller", "seller")
	if err != nil {
		t.Fatal(err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		AuctionID string `json:"auctionId"`
	}
	parentRules := model.Rules{
		Mode: model.ModeSealedFirst, StartPriceCents: 8000, IncrementCents: 1000,
		CapPriceCents: 0, DurationSec: 60, ExtendWindowSec: 0, ExtendSec: 0,
	}
	if err := postJSON(hc, target+"/api/auctions", seller.Token, map[string]any{
		"productId": productID, "rules": parentRules, "factsConfirmed": true,
	}, &created); err != nil {
		t.Fatal(err)
	}
	parentAID := created.AuctionID
	if err := postExpectCode(hc, target+"/api/auctions/"+parentAID+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		t.Fatal(err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+parentAID+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	for _, bid := range []struct {
		userID string
		amount string
	}{
		{"u_high", "13000"},
		{"u_mid", "9000"},
		{"u_low", "8000"},
	} {
		code, _, _, err := srv.st.PlaceBidSealed(ctx, parentAID, bid.userID, "cb_"+bid.userID, bid.amount, bid.userID)
		if err != nil || code != model.CodeOKAccepted {
			t.Fatalf("sealed bid %s: code=%s err=%v", bid.userID, code, err)
		}
	}
	if err := srv.st.Redis().HSet(ctx, "auction:{"+parentAID+"}:state", "endAtMs", "1").Err(); err != nil {
		t.Fatal(err)
	}
	code, _, err := srv.st.CloseAuction(ctx, parentAID)
	if err != nil || code != model.CodeOKSold {
		t.Fatalf("close parent: code=%s err=%v", code, err)
	}

	var rec prequalifyRecommendation
	if err := getJSONAuth(hc, target+"/api/auctions/"+parentAID+"/prequalify-recommendation", seller.Token, &rec); err != nil {
		t.Fatal(err)
	}
	if !rec.AdvisoryOnly || rec.SealedSummary.Count != 3 {
		t.Fatalf("bad recommendation shape: %+v", rec)
	}
	if rec.SealedSummary.MaxCents != "13000" || rec.SealedSummary.SecondCents != "9000" || rec.RecommendedReserveCents != "9000" {
		t.Fatalf("recommendation did not use sealed aggregate/outlier rule: %+v", rec)
	}

	formalRules := model.Rules{
		Mode: model.ModeEnglish, StartPriceCents: 0, IncrementCents: 1000,
		CapPriceCents: 0, DurationSec: 60, ExtendWindowSec: 10, ExtendSec: 10,
	}
	var spawn struct {
		AuctionID               string                  `json:"auctionId"`
		ParentAuctionID         string                  `json:"parentAuctionId"`
		SeededStartPriceCents   string                  `json:"seededStartPriceCents"`
		RecommendedReserveCents string                  `json:"recommendedReserveCents"`
		SealedSummary           prequalifySealedSummary `json:"sealedSummary"`
		Reused                  bool                    `json:"reused"`
	}
	if err := postJSON(hc, target+"/api/auctions/"+parentAID+"/spawn-formal", seller.Token, map[string]any{"rules": formalRules}, &spawn); err != nil {
		t.Fatal(err)
	}
	if spawn.ParentAuctionID != parentAID || spawn.SeededStartPriceCents != "9000" || spawn.RecommendedReserveCents != "9000" || spawn.SealedSummary.Count != 3 || spawn.Reused {
		t.Fatalf("bad spawn response: %+v", spawn)
	}
	var formalSnap model.RoomSnapshotData
	if err := getJSONAuth(hc, target+"/api/auctions/"+spawn.AuctionID, seller.Token, &formalSnap); err != nil {
		t.Fatal(err)
	}
	if formalSnap.Rules == nil || formalSnap.Rules.ReserveCents != "9000" || formalSnap.Rules.Mode != model.ModeEnglish {
		t.Fatalf("formal snapshot did not persist recommended floor in rules: %+v", formalSnap)
	}

	var reused struct {
		AuctionID             string `json:"auctionId"`
		SeededStartPriceCents string `json:"seededStartPriceCents"`
		Reused                bool   `json:"reused"`
	}
	if err := postJSON(hc, target+"/api/auctions/"+parentAID+"/spawn-formal", seller.Token, map[string]any{"rules": formalRules}, &reused); err != nil {
		t.Fatal(err)
	}
	if reused.AuctionID != spawn.AuctionID || !reused.Reused || reused.SeededStartPriceCents != "9000" {
		t.Fatalf("repeated spawn should reuse existing formal auction, got %+v", reused)
	}
}
