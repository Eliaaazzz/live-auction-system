package server

import "testing"

// HT-080 (review doc): a critical room event must NOT be silently dropped for a
// slow client. When the send buffer is full, broadcast drops (closes) the
// connection so it reconnects + re-snapshots, rather than losing the event.
func TestHiddenHubClosesSlowClientOnCriticalEvent(t *testing.T) {
	h := newHub()
	c := &Conn{send: make(chan []byte, 1), done: make(chan struct{}), aid: "auc_x"}
	h.join("auc_x", c)

	c.send <- []byte("filler") // fill the 1-slot buffer
	h.broadcast("auc_x", []byte(`{"type":"AUCTION_SOLD","seq":2}`))

	select {
	case <-c.done:
		// connection closed as required (client will reconnect + re-snapshot)
	default:
		t.Fatal("full critical broadcast must close the slow client, not silently drop")
	}
}

// HT-091 (review doc): leaderboard ?n= clamps to [1,100], defaulting to 10 for
// missing/invalid input (documented lenient behavior, bounds the ZREVRANGE).
func TestHiddenClampLeaderboardN(t *testing.T) {
	cases := map[string]int{
		"":     10,  // missing -> default
		"abc":  10,  // non-numeric -> default
		"0":    10,  // non-positive -> default
		"-5":   10,  // negative -> default
		"1":    1,   // min
		"50":   50,  // in range
		"100":  100, // max
		"1000": 100, // clamp to max
	}
	for in, want := range cases {
		if got := clampLeaderboardN(in); got != want {
			t.Errorf("clampLeaderboardN(%q)=%d want %d", in, got, want)
		}
	}
}
