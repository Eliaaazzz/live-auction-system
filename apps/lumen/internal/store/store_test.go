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

func TestSnapshotRulesReserveFallsBackToCurrentPrice(t *testing.T) {
	rules := snapshotRules(map[string]string{
		"incrementCents":    "1000",
		"reserveCents":      "",
		"startPriceCents":   "",
		"currentPriceCents": "9000",
	})
	if rules == nil {
		t.Fatal("snapshotRules returned nil")
	}
	if got, want := rules.ReserveCents, "9000"; got != want {
		t.Fatalf("ReserveCents=%q want %q", got, want)
	}
}
