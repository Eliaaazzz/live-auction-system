package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClassifyHost(t *testing.T) {
	cases := []struct {
		in   string
		want hostClass
	}{
		{"ws://127.0.0.1:8080", hostLoopback},
		{"ws://localhost:8080", hostLoopback},
		{"wss://localhost", hostLoopback},
		{"ws://[::1]:8080", hostLoopback},
		{"ws://10.0.0.5:80", hostPrivate},
		{"ws://172.31.12.98:80", hostPrivate}, // #231 Test D path (passed)
		{"ws://192.168.1.1", hostPrivate},
		{"ws://100.64.0.1:80", hostPrivate},     // RFC 6598 CGNAT
		{"ws://169.254.1.1", hostPrivate},       // link-local
		{"ws://[fd00::1]:80", hostPrivate},      // IPv6 ULA
		{"ws://115.191.76.40:80", hostPublicIP}, // #231 self-dial footgun
		{"ws://8.8.8.8", hostPublicIP},
		{"ws://[2001:db8::1]:80", hostPublicIP},
		{"wss://gw.example.com", hostName},
		{"ws://lumen:8080", hostName},
		{"115.191.76.40:80", hostPublicIP}, // bare host:port, no scheme
		{"10.0.0.5", hostPrivate},          // bare host, no port
		{"", hostUnknown},
	}
	for _, c := range cases {
		got, _ := classifyHost(c.in)
		if got != c.want {
			t.Errorf("classifyHost(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestParsePreflightMode(t *testing.T) {
	cases := []struct {
		in      string
		want    preflightMode
		wantErr bool
	}{
		{"", preflightAbort, false},
		{"abort", preflightAbort, false},
		{"WARN", preflightWarn, false},
		{"warn", preflightWarn, false},
		{"off", preflightOff, false},
		{"false", preflightOff, false},
		{"skip", preflightOff, false},
		{"bogus", preflightAbort, true},
	}
	for _, c := range cases {
		got, err := parsePreflightMode(c.in)
		if (err != nil) != c.wantErr {
			t.Errorf("parsePreflightMode(%q) err = %v, wantErr %v", c.in, err, c.wantErr)
		}
		if got != c.want {
			t.Errorf("parsePreflightMode(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestEvaluatePreflightPass(t *testing.T) {
	cfg := preflightConfig{minOK: 0.9}
	pass, diag := evaluatePreflight(
		preflightResult{attempted: 20, connectOK: 20, framesSeen: 20}, cfg, hostPrivate, "172.31.12.98")
	if !pass {
		t.Fatalf("expected pass, got fail: %s", diag)
	}
	if !strings.Contains(diag, "OK") || !strings.Contains(diag, "frames flowing") {
		t.Errorf("pass diag unexpected: %q", diag)
	}
}

func TestEvaluatePreflightPassButNoFrames(t *testing.T) {
	cfg := preflightConfig{minOK: 0.9}
	pass, diag := evaluatePreflight(
		preflightResult{attempted: 20, connectOK: 20, framesSeen: 0}, cfg, hostPrivate, "172.31.12.98")
	if !pass {
		t.Fatalf("expected pass (connects fine), got fail: %s", diag)
	}
	if !strings.Contains(diag, "0 server frames") {
		t.Errorf("expected idle-auction note, got: %q", diag)
	}
}

func TestEvaluatePreflightFailPublicHairpin(t *testing.T) {
	cfg := preflightConfig{minOK: 0.9}
	pass, diag := evaluatePreflight(
		preflightResult{attempted: 20, connectOK: 2, framesSeen: 0, sampleErr: "i/o timeout"},
		cfg, hostPublicIP, "115.191.76.40")
	if pass {
		t.Fatal("expected fail for 2/20 connects")
	}
	for _, want := range []string{"FAIL", "115.191.76.40", "hairpin", "PRIVATE", "#231", "i/o timeout"} {
		if !strings.Contains(diag, want) {
			t.Errorf("public-IP fail diag missing %q:\n%s", want, diag)
		}
	}
}

func TestEvaluatePreflightFailHostnameNoHairpin(t *testing.T) {
	cfg := preflightConfig{minOK: 0.9}
	pass, diag := evaluatePreflight(
		preflightResult{attempted: 20, connectOK: 1}, cfg, hostName, "gw.example.com")
	if pass {
		t.Fatal("expected fail for 1/20 connects")
	}
	if strings.Contains(diag, "hairpin") {
		t.Errorf("hostname target should not get the hairpin note:\n%s", diag)
	}
	if !strings.Contains(diag, "LB WebSocket") {
		t.Errorf("hostname fail should suggest LB/timeout checks:\n%s", diag)
	}
}

func TestEvaluatePreflightThresholdBoundary(t *testing.T) {
	cfg := preflightConfig{minOK: 0.9}
	if pass, _ := evaluatePreflight(preflightResult{attempted: 20, connectOK: 18, framesSeen: 1}, cfg, hostPrivate, "x"); !pass {
		t.Error("18/20 == 0.90 should pass (>=)")
	}
	if pass, _ := evaluatePreflight(preflightResult{attempted: 20, connectOK: 17, framesSeen: 1}, cfg, hostPrivate, "x"); pass {
		t.Error("17/20 == 0.85 should fail")
	}
}

func TestOkFractionZeroAttempts(t *testing.T) {
	if f := (preflightResult{}).okFraction(); f != 0 {
		t.Errorf("okFraction with 0 attempts = %v, want 0", f)
	}
}

func TestCollapseDialErr(t *testing.T) {
	long := errors.New("dial tcp 115.191.76.40:80: connect: connection timed out (some long volatile suffix here)")
	if got := collapseDialErr(long); !strings.Contains(got, "connection timed out") || strings.Contains(got, "dial tcp 115") {
		t.Errorf("collapseDialErr did not collapse long error: %q", got)
	}
	short := errors.New("EOF")
	if got := collapseDialErr(short); got != "EOF" {
		t.Errorf("collapseDialErr(short) = %q, want EOF", got)
	}
}

func TestParseCents(t *testing.T) {
	cases := []struct {
		in     string
		want   int64
		wantOK bool
	}{
		{"100000", 100000, true},
		{"0", 0, true},
		{"", 0, false},
		{"abc", 0, false},
	}
	for _, c := range cases {
		got, ok := parseCents(c.in)
		if got != c.want || ok != c.wantOK {
			t.Errorf("parseCents(%q) = (%d,%v), want (%d,%v)", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

func TestPct(t *testing.T) {
	sorted := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	if got := pct(sorted, 50); got != 5 {
		t.Errorf("pct(p50) = %v, want 5", got)
	}
	if got := pct(sorted, 100); got != 10 {
		t.Errorf("pct(p100) = %v, want 10", got)
	}
	if got := pct(nil, 95); got != 0 {
		t.Errorf("pct(nil) = %v, want 0", got)
	}
}

func TestLoadTokens(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "tokens.txt")
	body := "user_a.deadbeef\n\n  user_b.cafef00d  \n\t\nuser_c.0badf00d\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := loadTokens(p)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"user_a.deadbeef", "user_b.cafef00d", "user_c.0badf00d"}
	if len(got) != len(want) {
		t.Fatalf("loadTokens returned %d tokens, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("token[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestRunPreflightUnreachable exercises the dialing path against a closed port:
// it must finish within the budget and report all attempts as failed connects.
func TestRunPreflightUnreachable(t *testing.T) {
	cfg := preflightConfig{conns: 3, minOK: 0.9, budget: 1500 * time.Millisecond}
	start := time.Now()
	// 127.0.0.1:1 is reserved/closed — connection is refused quickly.
	res := runPreflight("ws://127.0.0.1:1", "auc_x", []string{"t1", "t2", "t3"}, cfg)
	if res.attempted != 3 {
		t.Errorf("attempted = %d, want 3", res.attempted)
	}
	if res.connectOK != 0 {
		t.Errorf("connectOK = %d, want 0 (port closed)", res.connectOK)
	}
	if res.sampleErr == "" {
		t.Error("expected a sample dial error")
	}
	if elapsed := time.Since(start); elapsed > 2*cfg.budget {
		t.Errorf("preflight took %s, should fail fast within ~budget (%s)", elapsed, cfg.budget)
	}
}
