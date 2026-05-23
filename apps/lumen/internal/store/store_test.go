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
	if got := AIDFromPubChannel("garbage"); got != "" {
		t.Errorf("garbage channel should yield empty, got %q", got)
	}
}
