package ssrf

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── blocked() unit tests — the IP allowlist core ──────────────────

func TestBlocked_RejectsForbiddenRanges(t *testing.T) {
	cases := []struct {
		name string
		ip   string
		want bool
	}{
		// TC-T7-101: IMDS
		{"IMDS metadata", "169.254.169.254", true},
		{"link-local generic", "169.254.0.1", true},
		// TC-T7-102: private CIDRs
		{"private 10/8", "10.0.0.1", true},
		{"private 172.16/12", "172.16.5.4", true},
		{"private 192.168/16", "192.168.1.1", true},
		{"loopback", "127.0.0.1", true},
		{"loopback edge", "127.255.255.255", true},
		{"unspecified", "0.0.0.0", true},
		{"multicast", "224.0.0.1", true},
		{"IPv6 loopback", "::1", true},
		{"IPv6 unique-local", "fc00::1", true},
		{"IPv6 link-local", "fe80::1", true},
		// allowed: public IPs
		{"public 1", "8.8.8.8", false},
		{"public 2", "93.184.216.34", false}, // example.com
		{"public IPv6", "2606:2800:220:1:248:1893:25c8:1946", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ip := net.ParseIP(c.ip)
			if ip == nil {
				t.Fatalf("bad test IP %q", c.ip)
			}
			if got := blocked(ip); got != c.want {
				t.Errorf("blocked(%s) = %v, want %v", c.ip, got, c.want)
			}
		})
	}
}

// ─── FetchImage integration — dial-time blocking + redirect + size ──

// TC-T7-101 + TC-T7-102: a URL whose host resolves to a forbidden IP is
// rejected at dial. We use literal IPs so no DNS is needed.
func TestFetchImage_TC_T7_101_102_BlocksForbiddenHosts(t *testing.T) {
	client := NewClient()
	for _, url := range []string{
		"http://169.254.169.254/latest/meta-data/iam/security-credentials/", // IMDS
		"http://10.0.0.1/internal.jpg",                                      // private
		"http://192.168.1.1/admin.png",                                      // private
		"http://127.0.0.1:8090/healthz",                                     // loopback (sidecar's own surface)
	} {
		_, err := FetchImage(context.Background(), client, url)
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("%s: expected ErrBlockedAddress, got %v", url, err)
		}
	}
}

// TC-T7-103: a host that 302-redirects (→ 169.254.169.254) must be refused —
// the classic SSRF-via-redirect bypass. Drives the REAL guarded client; only
// the IP-block predicate is relaxed (so the loopback httptest server is
// reachable), leaving the no-redirect CheckRedirect under test exactly as
// production ships it.
func TestFetchImage_TC_T7_103_BlocksRedirect(t *testing.T) {
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/creds", http.StatusFound)
	}))
	defer redirector.Close()

	_, err := FetchImage(context.Background(), newClient(allowAllIPs), redirector.URL)
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("expected ErrRedirect through the guarded client, got %v", err)
	}
}

// TC-T7-104: a response larger than the 10MiB cap is rejected — through the
// REAL guarded client + FetchImage's LimitReader (predicate relaxed only to
// reach the loopback server).
func TestFetchImage_TC_T7_104_RejectsOversize(t *testing.T) {
	big := strings.Repeat("x", maxImageBytes+1024) // just over the cap
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(big))
	}))
	defer srv.Close()

	_, err := FetchImage(context.Background(), newClient(allowAllIPs), srv.URL)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
}

// TC-T7-104b: a response exactly at the cap is allowed (boundary).
func TestFetchImage_ExactlyAtCapAllowed(t *testing.T) {
	atCap := strings.Repeat("x", maxImageBytes)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(atCap))
	}))
	defer srv.Close()

	body, err := FetchImage(context.Background(), newClient(allowAllIPs), srv.URL)
	if err != nil {
		t.Fatalf("exactly-at-cap should pass, got %v", err)
	}
	if len(body) != maxImageBytes {
		t.Fatalf("expected %d bytes, got %d", maxImageBytes, len(body))
	}
}

// allowAllIPs is the relaxed dial predicate the redirect/size tests inject so
// the loopback httptest server is reachable through the REAL transport. The
// IP-block path itself is covered UNrelaxed by TC-T7-101/102 +
// TestBlocked_RejectsForbiddenRanges, so relaxing it here doesn't lose coverage.
func allowAllIPs(net.IP) bool { return false }
