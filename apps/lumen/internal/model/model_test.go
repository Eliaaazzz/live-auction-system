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

// HT-002 (review doc): every outgoing envelope carries a schemaVersion for
// wire-protocol evolution. (channel routing is a separate T5 backpressure item.)
func TestHiddenEnvelopeCarriesSchemaVersion(t *testing.T) {
	env, err := NewEnvelope(TypeBidAccepted, "auc_1", 7, BidAcceptedData{Seq: 7, AmountCents: "100"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(string(b), `"schemaVersion":1`) {
		t.Fatalf("envelope missing schemaVersion: %s", b)
	}
	// still decodes back to the typed fields (schemaVersion is ignored on decode).
	var got Envelope
	if err := json.Unmarshal(b, &got); err != nil || got.Type != TypeBidAccepted || got.Seq != 7 {
		t.Fatalf("decode=%+v err=%v", got, err)
	}
}

func FuzzEnvelopeJSONBoundary(f *testing.F) {
	f.Add(`{"type":"ROOM_JOIN","auctionId":"auc_1","serverTimeMs":1700000000000,"data":{"auctionId":"auc_1","lastSeq":7}}`)
	f.Add(`{"type":"BID_PLACE","auctionId":"auc_1","requestId":"r1","serverTimeMs":1700000000000,"data":{"clientBidId":"cb1","amountCents":"11000"}}`)
	f.Add(`{"schemaVersion":1,"type":"BID_ACCEPTED","auctionId":"auc_1","seq":8,"serverTimeMs":1700000000000,"data":{"seq":8,"userId":"u1","displayName":"U","amountCents":"12000","endAtMs":1700000010000,"status":"LIVE","serverTimeMs":1700000000000}}`)
	f.Add(`{"type":"PING","serverTimeMs":0}`)
	f.Add(`not-json`)

	f.Fuzz(func(t *testing.T, input string) {
		var env Envelope
		if err := json.Unmarshal([]byte(input), &env); err != nil {
			return // malformed client frames must be rejectable without panics.
		}
		out, err := json.Marshal(env)
		if err != nil {
			t.Fatalf("marshal decoded envelope: %v", err)
		}
		if !json.Valid(out) {
			t.Fatalf("marshaled envelope is invalid json: %q", out)
		}
		if !contains(string(out), `"schemaVersion":1`) {
			t.Fatalf("marshaled envelope missing schemaVersion: %s", out)
		}
		var roundTrip Envelope
		if err := json.Unmarshal(out, &roundTrip); err != nil {
			t.Fatalf("round-trip decode: %v\n%s", err, out)
		}
		if roundTrip.Type != env.Type || roundTrip.AuctionID != env.AuctionID || roundTrip.RequestID != env.RequestID || roundTrip.Seq != env.Seq {
			t.Fatalf("round-trip envelope drift: got=%+v want type=%q auction=%q request=%q seq=%d", roundTrip, env.Type, env.AuctionID, env.RequestID, env.Seq)
		}
	})
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
	okVickrey := Rules{Mode: ModeVickrey, StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000, DurationSec: 60}
	if err := okVickrey.Validate(); err != nil {
		t.Fatalf("VICKREY rules rejected: %v", err)
	}
	// cap==0 means no ceiling — valid.
	noCap := ok
	noCap.CapPriceCents = 0
	if err := noCap.Validate(); err != nil {
		t.Fatalf("no-cap rules rejected: %v", err)
	}
	// cap above start but below the first increment is valid (buy-now reachable via
	// the cap-aware required price). Pins the relaxed cap rule (was cap>=start+inc).
	capBelowIncrement := Rules{StartPriceCents: 10000, IncrementCents: 5000, CapPriceCents: 12000, DurationSec: 60}
	if err := capBelowIncrement.Validate(); err != nil {
		t.Fatalf("cap-below-first-increment rules rejected: %v", err)
	}
	bad := map[string]Rules{
		"negative start":      {StartPriceCents: -1, IncrementCents: 1000, DurationSec: 60},
		"zero increment":      {StartPriceCents: 10000, IncrementCents: 0, DurationSec: 60},
		"negative increment":  {StartPriceCents: 10000, IncrementCents: -5, DurationSec: 60},
		"negative cap":        {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: -1, DurationSec: 60},
		"cap equals start":    {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 10000, DurationSec: 60},
		"cap below start":     {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 9000, DurationSec: 60},
		"bad mode":            {Mode: "sealed", StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 12000, DurationSec: 60},
		"money over max":      {StartPriceCents: MaxMoneyCents + 1, IncrementCents: 1000, DurationSec: 60},
		"cap over max":        {StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: MaxMoneyCents + 1, DurationSec: 60},
		"zero duration":       {StartPriceCents: 10000, IncrementCents: 1000, DurationSec: 0},
		"negative extend win": {StartPriceCents: 10000, IncrementCents: 1000, DurationSec: 60, ExtendWindowSec: -1},
		"negative maxExt":     {StartPriceCents: 10000, IncrementCents: 1000, DurationSec: 60, MaxExtensions: -1},
	}
	for name, r := range bad {
		if err := r.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

// HT-090 (review doc): Cents.Scan must reject invalid SQL bytes, not silently 0.
func TestHiddenCentsScanInvalidBytes(t *testing.T) {
	var c Cents
	if err := c.Scan([]byte("not-a-number")); err == nil {
		t.Fatalf("Cents.Scan([]byte bad) must error, got nil and value=%d", int64(c))
	}
	// valid bytes still scan.
	if err := c.Scan([]byte("4200")); err != nil || c != 4200 {
		t.Fatalf("Cents.Scan([]byte \"4200\")=%d err=%v want 4200/nil", int64(c), err)
	}
}

// HT-001 (review doc): pin the canonical auction-status constant values so an
// accidental rename (or a drift toward #2's BIDDING/HAMMERED) is caught. Team
// decision: #1 LIVE/SOLD/NO_BID is canonical for T2; #2's order/auction split is
// adopted separately (ORDER_CREATED moving to order lifecycle).
func TestHiddenStateMachineCanonicalConstants(t *testing.T) {
	want := map[string]string{
		StateDraft: "DRAFT", StateScheduled: "SCHEDULED", StateLive: "LIVE",
		StateSold: "SOLD", StateNoBid: "NO_BID", StateCancelled: "CANCELLED",
		StateOrderCreated: "ORDER_CREATED",
	}
	for got, exp := range want {
		if got != exp {
			t.Errorf("auction-status constant drifted: %q want %q", got, exp)
		}
	}
	// no V8 / #2 names leaked into the terminal set.
	for _, banned := range []string{"BIDDING", "HAMMERED", "PASSED", "RESERVE_NOT_MET"} {
		if IsTerminal(banned) {
			t.Errorf("%q must not be a recognized terminal state under #1", banned)
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
