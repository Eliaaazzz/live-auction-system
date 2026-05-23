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

func TestNewEnvelopeMarshalError(t *testing.T) {
	// a value that cannot be JSON-marshaled surfaces the error.
	if _, err := NewEnvelope(TypePong, "", 0, make(chan int)); err == nil {
		t.Fatal("expected marshal error for unmarshalable data")
	}
}

// money-as-string: Cents marshals to a quoted string at the JSON boundary.
func TestCentsMarshalJSON(t *testing.T) {
	b, err := json.Marshal(Cents(10000))
	if err != nil || string(b) != `"10000"` {
		t.Fatalf("marshal=%s err=%v want \"10000\"", b, err)
	}
	// inside a struct
	out, _ := json.Marshal(Rules{StartPriceCents: 250, IncrementCents: 5})
	if !json.Valid(out) || !contains(string(out), `"startPriceCents":"250"`) {
		t.Fatalf("rules json=%s", out)
	}
}

func TestCentsUnmarshalJSON(t *testing.T) {
	cases := map[string]int64{
		`"10000"`: 10000, // quoted (canonical boundary form)
		`10000`:   10000, // bare number (legacy clients)
		`""`:      0,     // empty
		`null`:    0,     // null
		`"0"`:     0,
	}
	for in, want := range cases {
		var c Cents
		if err := json.Unmarshal([]byte(in), &c); err != nil {
			t.Fatalf("unmarshal %s: %v", in, err)
		}
		if int64(c) != want {
			t.Fatalf("unmarshal %s = %d want %d", in, int64(c), want)
		}
	}
	var c Cents
	if err := json.Unmarshal([]byte(`"not-a-number"`), &c); err == nil {
		t.Fatal("expected error for non-numeric cents")
	}
}

func TestCentsScanValue(t *testing.T) {
	var c Cents
	if err := c.Scan(int64(42)); err != nil || c != 42 {
		t.Fatalf("scan int64: c=%d err=%v", c, err)
	}
	if err := c.Scan([]byte("99")); err != nil || c != 99 {
		t.Fatalf("scan []byte: c=%d err=%v", c, err)
	}
	if err := c.Scan(nil); err != nil || c != 0 {
		t.Fatalf("scan nil: c=%d err=%v", c, err)
	}
	if err := c.Scan("unsupported"); err == nil {
		t.Fatal("scan string should be unsupported")
	}
	v, err := Cents(7).Value()
	if err != nil || v.(int64) != 7 {
		t.Fatalf("value=%v err=%v", v, err)
	}
}

// PubMessage is the Lua→gateway fanout envelope; type + seq + raw data must
// round-trip so the subscriber can re-emit the right wire type.
func TestPubMessageRoundTrip(t *testing.T) {
	ext := AuctionExtendedData{Seq: 5, EndAtMs: 1700, ExtendCount: 2}
	raw, _ := json.Marshal(ext)
	pm := PubMessage{Type: TypeAuctionExtended, Seq: 5, Data: raw}
	b, _ := json.Marshal(pm)

	var got PubMessage
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != TypeAuctionExtended || got.Seq != 5 {
		t.Fatalf("pubmsg=%+v", got)
	}
	var back AuctionExtendedData
	if err := json.Unmarshal(got.Data, &back); err != nil || back != ext {
		t.Fatalf("data=%+v err=%v", back, err)
	}
}

func TestAuctionSoldDataShape(t *testing.T) {
	b, _ := json.Marshal(AuctionSoldData{Seq: 9, WinnerID: "u1", AmountCents: "50000", Status: StateSold})
	s := string(b)
	for _, want := range []string{`"winnerId":"u1"`, `"amountCents":"50000"`, `"status":"SOLD"`, `"seq":9`} {
		if !contains(s, want) {
			t.Fatalf("sold json %s missing %s", s, want)
		}
	}
}

func TestRulesValidate(t *testing.T) {
	ok := Rules{StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000, DurationSec: 60}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid rules rejected: %v", err)
	}
	// cap==0 means no ceiling — valid.
	noCap := ok
	noCap.CapPriceCents = 0
	if err := noCap.Validate(); err != nil {
		t.Fatalf("no-cap rules rejected: %v", err)
	}
	bad := map[string]Rules{
		"negative start":      {StartPriceCents: -1, IncrementCents: 1000, DurationSec: 60},
		"zero increment":      {StartPriceCents: 10000, IncrementCents: 0, DurationSec: 60},
		"negative increment":  {StartPriceCents: 10000, IncrementCents: -5, DurationSec: 60},
		"negative cap":        {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: -1, DurationSec: 60},
		"cap below 1st bid":   {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 10500, DurationSec: 60},
		"zero duration":       {StartPriceCents: 10000, IncrementCents: 1000, DurationSec: 0},
		"negative extend win": {StartPriceCents: 10000, IncrementCents: 1000, DurationSec: 60, ExtendWindowSec: -1},
	}
	for name, r := range bad {
		if err := r.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
