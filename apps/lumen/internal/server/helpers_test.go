package server

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestValidAmount(t *testing.T) {
	ok := []string{"1", "11000", "9223372036854775807"} // up to int64 max
	for _, s := range ok {
		if !validAmount(s) {
			t.Errorf("validAmount(%q)=false, want true", s)
		}
	}
	bad := []string{"", "0", "-1", "abc", "1.5", "11000 ", "0x10",
		"9223372036854775808"} // int64 overflow
	for _, s := range bad {
		if validAmount(s) {
			t.Errorf("validAmount(%q)=true, want false", s)
		}
	}
}

func TestBidErrCode(t *testing.T) {
	// NOSCRIPT is a genuine dispatcher fault -> ERR_INTERNAL.
	if got := bidErrCode(errors.New("NOSCRIPT No matching script")); got != model.CodeErrInternal {
		t.Errorf("NOSCRIPT -> %s, want ERR_INTERNAL", got)
	}
	// any other transport error means Redis is effectively down -> ERR_AUCTION_PAUSED.
	if got := bidErrCode(errors.New("dial tcp: connection refused")); got != model.CodeErrPaused {
		t.Errorf("transport err -> %s, want ERR_AUCTION_PAUSED", got)
	}
}

func TestRejectedAndAcceptedEnvelopes(t *testing.T) {
	r := rejected("auc_1", model.CodeErrTooLow)
	if r.Type != model.TypeBidRejected || r.AuctionID != "auc_1" {
		t.Fatalf("rejected envelope=%+v", r)
	}
	var rd model.BidRejectedData
	if err := json.Unmarshal(r.Data, &rd); err != nil || rd.Code != model.CodeErrTooLow {
		t.Fatalf("rejected data=%+v err=%v", rd, err)
	}

	payload := `{"seq":3,"userId":"u1","amountCents":"12000","endAtMs":1700,"status":"LIVE"}`
	a := bidAccepted("auc_1", payload)
	if a.Type != model.TypeBidAccepted || a.Seq != 3 {
		t.Fatalf("accepted envelope=%+v", a)
	}
	var ad model.BidAcceptedData
	if err := json.Unmarshal(a.Data, &ad); err != nil || ad.AmountCents != "12000" || ad.Seq != 3 {
		t.Fatalf("accepted data=%+v err=%v", ad, err)
	}
}

func TestDecodePub(t *testing.T) {
	// BID_ACCEPTED fanout
	bid := model.BidAcceptedData{Seq: 4, UserID: "u1", AmountCents: "13000", Status: model.StateLive}
	raw, _ := json.Marshal(bid)
	pm, _ := json.Marshal(model.PubMessage{Type: model.TypeBidAccepted, Seq: 4, Data: raw})
	env, ok := decodePub("auc_1", string(pm))
	if !ok || env.Type != model.TypeBidAccepted || env.AuctionID != "auc_1" || env.Seq != 4 {
		t.Fatalf("bid pub decode: ok=%v env=%+v", ok, env)
	}
	var got model.BidAcceptedData
	if err := json.Unmarshal(env.Data, &got); err != nil || got.AmountCents != "13000" {
		t.Fatalf("bid data=%+v err=%v", got, err)
	}

	// AUCTION_EXTENDED fanout keeps its type
	ext, _ := json.Marshal(model.PubMessage{Type: model.TypeAuctionExtended, Seq: 5, Data: json.RawMessage(`{"endAtMs":1700}`)})
	if env, ok := decodePub("auc_1", string(ext)); !ok || env.Type != model.TypeAuctionExtended || env.Seq != 5 {
		t.Fatalf("extended pub decode: ok=%v env=%+v", ok, env)
	}

	// malformed / typeless are skipped
	if _, ok := decodePub("auc_1", "not json"); ok {
		t.Error("malformed pub should be skipped")
	}
	if _, ok := decodePub("auc_1", `{"seq":1,"data":{}}`); ok {
		t.Error("typeless pub should be skipped")
	}
}

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"Hello World": "hello_world",
		"  Trim Me  ": "trim_me",
		"a-b_c":       "a_b_c",
		"Café 99":     "caf_99", // non-ascii dropped, digits kept
		"":            "anon",
		"!!!":         "anon",
		"UPPER":       "upper",
	}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q)=%q want %q", in, got, want)
		}
	}
}

func TestNewID(t *testing.T) {
	a, b := newID(), newID()
	if len(a) != 16 || len(b) != 16 { // 8 random bytes -> 16 hex chars
		t.Fatalf("newID len: %d/%d want 16", len(a), len(b))
	}
	if a == b {
		t.Fatal("newID returned identical ids")
	}
}

func TestPercentilesAndRank(t *testing.T) {
	if p50, p95, p99 := percentiles(nil); p50 != 0 || p95 != 0 || p99 != 0 {
		t.Fatalf("empty percentiles=%v/%v/%v want 0", p50, p95, p99)
	}
	xs := make([]time.Duration, 100) // 1ms..100ms
	for i := range xs {
		xs[i] = time.Duration(i+1) * time.Millisecond
	}
	p50, p95, p99 := percentiles(xs)
	if p50 != 50*time.Millisecond || p95 != 95*time.Millisecond || p99 != 99*time.Millisecond {
		t.Fatalf("percentiles=%v/%v/%v want 50/95/99ms", p50, p95, p99)
	}
	// single sample: every percentile is that sample.
	one, _, _ := percentiles([]time.Duration{7 * time.Millisecond})
	if one != 7*time.Millisecond {
		t.Fatalf("single-sample p50=%v want 7ms", one)
	}
	// rank clamps.
	if rank(10, 0) != 0 || rank(10, 100) != 9 {
		t.Fatalf("rank clamp: %d/%d", rank(10, 0), rank(10, 100))
	}
}

func TestEnvInt(t *testing.T) {
	if envInt("LUMEN_NOPE_XYZ", 42) != 42 {
		t.Error("envInt default")
	}
	t.Setenv("LUMEN_TEST_INT", "7")
	if envInt("LUMEN_TEST_INT", 42) != 7 {
		t.Error("envInt parse")
	}
	t.Setenv("LUMEN_TEST_INT", "not-a-number")
	if envInt("LUMEN_TEST_INT", 42) != 42 {
		t.Error("envInt invalid -> default")
	}
	t.Setenv("LUMEN_TEST_INT", "-3")
	if envInt("LUMEN_TEST_INT", 42) != 42 {
		t.Error("envInt non-positive -> default")
	}
}
