package server

// T4 hidden probe by @fariZzzz — challenges the fe-projection hardening (8d8fa16,
// PDGGK) that moved the evidence-card summary OFF the live Redis snapshot and ONTO
// the persisted hash chain via the new pure function evidenceSummary(). The existing
// T4 tests exercise the SOLD path end-to-end, but the NO_BID / CANCELLED / LIVE
// derivation branches and the order-override are only reachable through this pure
// function — unit-testing it directly pins the read-path logic with no infra.

import (
	"encoding/json"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func ev(seq int64, typ string, v any) store.EvidenceEvent {
	b, _ := json.Marshal(v)
	return store.EvidenceEvent{Seq: seq, EventType: typ, Payload: json.RawMessage(b)}
}

// TC-T4-110 — evidenceSummary derives status/price/winner/seq from the chain (not
// live Redis) for every terminal + the LIVE-with-bids case, and the order override
// wins when present. This is the read-path the 8d8fa16 hardening introduced.
func TestT4EvidenceSummaryDerivesFromChain(t *testing.T) {
	bid := func(seq int64, user, cents string) store.EvidenceEvent {
		return ev(seq, model.TypeBidAccepted, model.BidAcceptedData{Seq: seq, UserID: user, AmountCents: cents, Status: model.StateLive})
	}

	tests := []struct {
		name        string
		mysqlStatus string
		timeline    []store.EvidenceEvent
		order       store.Order
		hasOrder    bool
		wantStatus  string
		wantPrice   string
		wantWinner  string
		wantSeq     int64
	}{
		{
			name:        "live with bids — status from mysql, price/winner from last BID_ACCEPTED",
			mysqlStatus: model.StateLive,
			timeline:    []store.EvidenceEvent{bid(1, "u1", "11000"), bid(2, "u2", "12000")},
			wantStatus:  model.StateLive, wantPrice: "12000", wantWinner: "u2", wantSeq: 2,
		},
		{
			name:        "no_bid terminal",
			mysqlStatus: model.StateLive,
			timeline:    []store.EvidenceEvent{ev(1, model.TypeAuctionNoBid, model.AuctionNoBidData{Seq: 1})},
			wantStatus:  model.StateNoBid, wantPrice: "", wantWinner: "", wantSeq: 1,
		},
		{
			name:        "cancelled terminal — even with a prior bid, no winner carried",
			mysqlStatus: model.StateLive,
			timeline:    []store.EvidenceEvent{bid(1, "u1", "11000"), ev(2, model.TypeAuctionCancelled, map[string]any{"seq": 2})},
			wantStatus:  model.StateCancelled, wantPrice: "11000", wantWinner: "u1", wantSeq: 2,
		},
		{
			name:        "sold terminal, no order yet — from AUCTION_SOLD payload",
			mysqlStatus: model.StateLive,
			timeline:    []store.EvidenceEvent{bid(1, "u1", "11000"), ev(2, model.TypeAuctionSold, model.AuctionSoldData{Seq: 2, WinnerID: "u1", AmountCents: "11000", Status: model.StateSold})},
			wantStatus:  model.StateSold, wantPrice: "11000", wantWinner: "u1", wantSeq: 2,
		},
		{
			name:        "sold + order — order override promotes to ORDER_CREATED",
			mysqlStatus: model.StateSold,
			timeline:    []store.EvidenceEvent{bid(1, "u1", "11000"), ev(2, model.TypeAuctionSold, model.AuctionSoldData{Seq: 2, WinnerID: "u1", AmountCents: "11000", Status: model.StateSold})},
			order:       store.Order{BuyerID: "u1", AmountCents: model.Cents(11000), Status: "created"},
			hasOrder:    true,
			wantStatus:  model.StateOrderCreated, wantPrice: "11000", wantWinner: "u1", wantSeq: 2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := evidenceSummary(tc.mysqlStatus, tc.timeline, tc.order, tc.hasOrder)
			if got.Status != tc.wantStatus {
				t.Errorf("status=%q want %q", got.Status, tc.wantStatus)
			}
			if got.CurrentPriceCents != tc.wantPrice {
				t.Errorf("price=%q want %q", got.CurrentPriceCents, tc.wantPrice)
			}
			if got.WinnerID != tc.wantWinner {
				t.Errorf("winner=%q want %q", got.WinnerID, tc.wantWinner)
			}
			if got.Seq != tc.wantSeq {
				t.Errorf("seq=%d want %d", got.Seq, tc.wantSeq)
			}
		})
	}
}
