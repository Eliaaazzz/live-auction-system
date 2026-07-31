package server

import (
	"math/rand"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestCrowdEnabled(t *testing.T) {
	on, off := true, false
	cases := []struct {
		name       string
		envDefault bool
		override   *bool
		want       bool
	}{
		{"env-on no override", true, nil, true},
		{"env-off no override", false, nil, false},
		{"env-on explicit off", true, &off, false},
		{"env-off explicit on", false, &on, true},
	}
	for _, tc := range cases {
		if got := crowdEnabled(tc.envDefault, tc.override); got != tc.want {
			t.Errorf("%s: crowdEnabled=%v, want %v", tc.name, got, tc.want)
		}
	}
}

// The sim must NEVER produce a bid that reaches the cap (cap touch = instant
// SOLD, reserved for humans) and must stop when even a single step would.
func TestNextCrowdAmountCapGuard(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	const step, cap = 5000, 1_200_000
	cur := int64(0)
	for i := 0; i < 10_000; i++ {
		amount, ok := nextCrowdAmount(cur, step, cap, rng)
		if !ok {
			// stop is only legal when the minimum legal raise would hit the cap
			if cur+step < cap {
				t.Fatalf("stopped early: cur=%d step=%d cap=%d", cur, step, cap)
			}
			return
		}
		if amount >= cap {
			t.Fatalf("sim bid %d reached cap %d", amount, cap)
		}
		if amount <= cur || (amount-cur)%step != 0 {
			t.Fatalf("sim bid %d is not a legal raise from %d (step %d)", amount, cur, step)
		}
		cur = amount
	}
	t.Fatalf("never hit the cap guard — cap ladder too long? cur=%d", cur)
}

func TestNextCrowdAmountNoCap(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	amount, ok := nextCrowdAmount(0, 100, 0, rng)
	if !ok || amount < 100 {
		t.Fatalf("no-cap first bid: got (%d, %v), want >=100, true", amount, ok)
	}
	// never overflows MaxMoneyCents
	if _, ok := nextCrowdAmount(int64(model.MaxMoneyCents), 100, 0, rng); ok {
		t.Fatal("bid above MaxMoneyCents must be refused")
	}
	if _, ok := nextCrowdAmount(100, 0, 0, rng); ok {
		t.Fatal("non-positive step must be refused")
	}
}

func TestCrowdBidGapClamp(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 2000; i++ {
		g := crowdBidGap(60_000, 4000, rng) // hot pace → clamps at the floor often
		if g < 200*time.Millisecond || g > 5*time.Second {
			t.Fatalf("gap %v outside [200ms, 5s]", g)
		}
	}
	if g := crowdBidGap(0, 1, rng); g < 200*time.Millisecond {
		t.Fatalf("zero-remaining gap %v below floor", g)
	}
}

func TestCrowdViewersAtRamp(t *testing.T) {
	rng := rand.New(rand.NewSource(9))
	const target = 9997
	early := crowdViewersAt(0, target, rng)
	if early < 1 || early > 200 {
		t.Fatalf("t=0 viewers=%d, want a small warm base", early)
	}
	full := crowdViewersAt(crowdRampMs+5_000, target, rng)
	if full < target-100 || full > target+100 {
		t.Fatalf("post-ramp viewers=%d, want ≈%d", full, target)
	}
	if v := crowdViewersAt(10_000, 0, rng); v != 0 {
		t.Fatalf("target 0 must yield 0, got %d", v)
	}
}

func TestSanitizeSocialText(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  hello \n world\t", "hello world"},
		{"\r\n", ""},
		{"the condition on this is unreal", "the condition on this is unreal"},
		{"a\x00b", "a b"},
	}
	for _, tc := range cases {
		if got := sanitizeSocialText(tc.in, 60); got != tc.want {
			t.Errorf("sanitize(%q)=%q, want %q", tc.in, got, tc.want)
		}
	}
	long := make([]rune, 0, 100)
	for i := 0; i < 100; i++ {
		long = append(long, 'x')
	}
	if got := sanitizeSocialText(string(long), 60); len([]rune(got)) != 60 {
		t.Errorf("cap: got %d runes, want 60", len([]rune(got)))
	}
}

func TestClampLikeDelta(t *testing.T) {
	for in, want := range map[int64]int64{-5: -1, -1: -1, 0: 1, 1: 1, 9: 1} {
		if got := clampLikeDelta(in); got != want {
			t.Errorf("clampLikeDelta(%d)=%d, want %d", in, got, want)
		}
	}
}

func TestSocialStateLikes(t *testing.T) {
	ss := newSocialState()
	if n := ss.addLikes("a", 1); n != 1 {
		t.Fatalf("first like: %d", n)
	}
	if n := ss.addLikes("a", -1); n != 0 {
		t.Fatalf("unlike: %d", n)
	}
	if n := ss.addLikes("a", -1); n != 0 {
		t.Fatalf("clamp at zero: %d", n)
	}
	// nil-safety (bare Server{} fixtures)
	var nilSS *socialState
	if n := nilSS.addLikes("a", 1); n != 0 {
		t.Fatalf("nil addLikes: %d", n)
	}
	if n := nilSS.likeCount("a"); n != 0 {
		t.Fatalf("nil likeCount: %d", n)
	}
	var nilCrowd *CrowdSim
	if v := nilCrowd.ViewerBoost("a"); v != 0 {
		t.Fatalf("nil ViewerBoost: %d", v)
	}
	nilCrowd.MaybeStart("a", nil) // must not panic
	nilCrowd.Stop("a")
}
