package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestCanonicalAmount(t *testing.T) {
	// valid inputs canonicalize to plain decimal (no leading zeros / plus sign).
	ok := map[string]string{
		"1":                "1",
		"11000":            "11000",
		"9007199254740991": "9007199254740991", // MaxMoneyCents (2^53-1)
		"0123":             "123",              // leading zero
		"+123":             "123",              // leading plus
		"007":              "7",
	}
	for in, want := range ok {
		got, valid := canonicalAmount(in)
		if !valid || got != want {
			t.Errorf("canonicalAmount(%q)=(%q,%v), want (%q,true)", in, got, valid, want)
		}
	}
	bad := []string{"", "0", "-1", "abc", "1.5", "11000 ", " 11000", "0x10", "1e3",
		"9007199254740992",    // MaxMoneyCents+1 (loses float64 precision)
		"9223372036854775807", // int64 max, > MaxMoneyCents
		"9223372036854775808"} // int64 overflow
	for _, s := range bad {
		if _, valid := canonicalAmount(s); valid {
			t.Errorf("canonicalAmount(%q) valid=true, want false", s)
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

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"Hello World": "hello_world",
		"  Trim Me  ": "trim_me",
		"a-b_c":       "a_b_c",
		"Café 99":     "caf_99", // non-ascii dropped, digits kept
		"":            "anon",
		"UPPER":       "upper",
		"BuyerA":      "buyera", // legacy mapping preserved - user_buyera keeps its bid/order history
		"BuyerB":      "buyerb",
	}
	for in, want := range cases {
		if got := slug(in); got != want {
			t.Errorf("slug(%q)=%q want %q", in, got, want)
		}
	}
}

// Empty-ASCII-residue nicknames (pure CJK/emoji/symbols) must NOT collapse into
// one shared "anon" account. Root-caused 2026-06-10: two phones each typing a non-ASCII
// nickname landed on the same user_anon, so each side judged the other's ROOM_SOCIAL
// broadcast to be its own and suppressed the animation, which looked like likes and gifts
// being out of sync across clients.
func TestSlugEmptyResidueDistinctAndStable(t *testing.T) {
	a, b := slug("Дмитрий"), slug("Ελένη")
	if a == "anon" || b == "anon" {
		t.Fatalf("pure-CJK nickname still collapses to bare anon: %q / %q", a, b)
	}
	if a == b {
		t.Fatalf("distinct non-ASCII nicknames collide: %q == %q", a, b)
	}
	if again := slug("Дмитрий"); again != a {
		t.Fatalf("slug unstable for same nickname: %q then %q", a, again)
	}
	if x, y := slug("!!!"), slug("???"); x == y {
		t.Fatalf("symbol-only nicknames collide: %q == %q", x, y)
	}
	// pin the output SHAPE of the hashed path: anon + 8 hex chars
	if x := slug("!!!"); len(x) != len("anon")+8 || !strings.HasPrefix(x, "anon") {
		t.Fatalf("hashed slug shape: %q want anon+8hex", x)
	}
	// whitespace-only trims to empty → bare anon (defensive branch, upstream rejects it)
	if got := slug("   "); got != "anon" {
		t.Fatalf("slug(whitespace-only)=%q want anon", got)
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
