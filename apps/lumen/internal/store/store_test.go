package store

import "testing"

func TestPubChannelRoundTrip(t *testing.T) {
	const aid = "auc_demo"
	ch := PubChannel(aid)
	if ch != "auction:{auc_demo}:pub" {
		t.Fatalf("PubChannel=%q", ch)
	}
	if got := AIDFromPubChannel(ch); got != aid {
		t.Fatalf("AIDFromPubChannel=%q want %q", got, aid)
	}
}

func TestKeyHelpers(t *testing.T) {
	if got := stateKey("a"); got != "auction:{a}:state" {
		t.Errorf("stateKey=%q", got)
	}
	if got := dedupeKey("a", "u"); got != "auction:{a}:dedupe:u" {
		t.Errorf("dedupeKey=%q", got)
	}
	if got := streamKey("a"); got != "auction:{a}:events" {
		t.Errorf("streamKey=%q", got)
	}
}

func TestParseInt(t *testing.T) {
	if parseInt("42") != 42 {
		t.Error("parseInt(42)")
	}
	if parseInt("") != 0 {
		t.Error("parseInt(empty)")
	}
}

func TestStreamRangeStart(t *testing.T) {
	cases := map[string]string{
		"":    "-",
		"1":   "1-0",
		"1-0": "1-0",
		"(2":  "2-0",
	}
	for in, want := range cases {
		if got := streamRangeStart(in); got != want {
			t.Errorf("streamRangeStart(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestStreamIDSeq(t *testing.T) {
	cases := map[string]int64{
		"":      0,
		"1":     1,
		"1-0":   1,
		"(2-0":  2,
		"nope":  0,
		"3-999": 3,
	}
	for in, want := range cases {
		if got := streamIDSeq(in); got != want {
			t.Errorf("streamIDSeq(%q)=%d, want %d", in, got, want)
		}
	}
}

func TestAIDFromPubChannelEdge(t *testing.T) {
	cases := []string{
		"garbage",
		"auction:foo:pub",
		"auction:{auc_demo}:pubx",
		"auction:{}:pub",
	}
	for _, ch := range cases {
		if got := AIDFromPubChannel(ch); got != "" {
			t.Errorf("AIDFromPubChannel(%q)=%q, want empty", ch, got)
		}
	}
}
