package model

import (
	"encoding/json"
	"testing"
)

func TestIsTerminal(t *testing.T) {
	for _, s := range []string{StateSold, StateNoBid, StateCancelled, StateOrderCreated} {
		if !IsTerminal(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
	for _, s := range []string{StateDraft, StateScheduled, StateLive} {
		if IsTerminal(s) {
			t.Errorf("%s should not be terminal", s)
		}
	}
}

func TestNewEnvelope(t *testing.T) {
	env, err := NewEnvelope(TypeBidAccepted, "auc_1", 7, BidAcceptedData{Seq: 7, AmountCents: "100"})
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != TypeBidAccepted || env.AuctionID != "auc_1" || env.Seq != 7 {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	var d BidAcceptedData
	if err := json.Unmarshal(env.Data, &d); err != nil || d.AmountCents != "100" {
		t.Fatalf("data=%+v err=%v", d, err)
	}
}
