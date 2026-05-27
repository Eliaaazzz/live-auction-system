package main

// PR #24 CR P1-4 hidden test: chaos-runner must refuse non-local targets
// unless --allow-non-local-target is set. Prevents the "I forgot to flip
// --compose-base after the demo" prod incident.

import "testing"

func TestIsLocalTarget(t *testing.T) {
	cases := []struct {
		raw     string
		want    bool
		comment string
	}{
		{"http://localhost:8080", true, "localhost loopback"},
		{"http://127.0.0.1:8080", true, "127.0.0.1 loopback"},
		{"http://[::1]:8080", true, "ipv6 loopback"},
		{"http://0.0.0.0:8080", true, "0.0.0.0 (treated as local)"},
		{"http://my-mac.local:8080", true, "mDNS .local"},
		{"http://127.18.0.5:8080", true, "127.0.0.0/8 (docker bridge style)"},
		{"http://example.com:8080", false, "public DNS"},
		{"http://10.0.1.4:8080", false, "private RFC1918 but non-loopback — refuse to be safe"},
		{"http://api.lumen-prod.cn:8080", false, "production hostname"},
		{"https://lumen.example.com", false, "https public"},
		{"not-a-url", false, "garbage"},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			if got := isLocalTarget(c.raw); got != c.want {
				t.Errorf("isLocalTarget(%q) = %v, want %v (%s)", c.raw, got, c.want, c.comment)
			}
		})
	}
}
