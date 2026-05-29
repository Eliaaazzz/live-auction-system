// Package ssrf provides an SSRF-guarded HTTP client for the VLM image
// fetch path (T7 §4.1, proto/ai-events.md §1.2).
//
// The threat: a seller-supplied `imageUrl` is fetched server-side by the
// sidecar before handing the image to the VLM. Without guards, that URL
// is a server-side request forgery primitive — a seller could point it
// at cloud metadata (169.254.169.254 → IAM creds), internal services
// (10.x / 192.168.x), or localhost (the sidecar's own admin surface).
//
// Defenses (all enforced here):
//   - DNS resolution + per-IP allowlist at DIAL time (not URL-parse time)
//     so a hostname resolving to a private IP is still rejected
//   - private CIDRs, loopback, link-local (IMDS), unspecified, multicast
//     all blocked
//   - redirects disabled (a 302 → http://169.254.169.254 bypass is the
//     classic SSRF-via-redirect; CheckRedirect returns an error)
//   - response body capped at maxImageBytes (a multi-GB "image" would OOM
//     the sidecar)
//   - hard timeout (a slow-loris image host can't hold a sidecar worker)
//
// The guard is at the dial layer because that's the only place that sees
// the *resolved* IP. URL-string blocklists are bypassable (decimal IPs,
// IPv6-mapped, DNS rebinding); IP-at-dial is the robust check.
package ssrf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Limits per proto/ai-events.md §1.2.
const (
	maxImageBytes = 10 << 20 // 10 MiB
	fetchTimeout  = 5 * time.Second
)

// ErrBlockedAddress is returned when the resolved IP is in a forbidden
// range. Wrapped so callers can errors.Is() it for a clean 502 mapping.
var ErrBlockedAddress = errors.New("ssrf: blocked address")

// ErrRedirect is returned when the remote tries to redirect — the VLM
// fetch never follows redirects (classic SSRF bypass vector).
var ErrRedirect = errors.New("ssrf: redirect not allowed")

// ErrTooLarge is returned when the response body exceeds maxImageBytes.
var ErrTooLarge = errors.New("ssrf: response exceeds size limit")

// NewClient builds an http.Client whose dialer rejects forbidden IPs,
// whose redirect policy is "never," and whose timeout is bounded. Use
// FetchImage for the size-capped read.
func NewClient() *http.Client {
	return newClient(blocked)
}

// newClient is NewClient parameterized on the IP-block predicate. Production
// uses NewClient() → newClient(blocked); tests pass a relaxed predicate so
// they can drive the REAL transport — the dial-guard IP-pin, the no-redirect
// CheckRedirect, and (via FetchImage) the size cap — against an httptest
// server, which always binds loopback (itself a blocked range). Relaxing the
// predicate isolates the redirect/size paths; it does not weaken what
// production ships, since NewClient() still passes blocked().
func newClient(isBlocked func(net.IP) bool) *http.Client {
	dialer := &net.Dialer{Timeout: fetchTimeout}
	return &http.Client{
		Timeout: fetchTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return ErrRedirect
		},
		Transport: &http.Transport{
			// control runs after DNS resolution, before connect — the
			// only hook with the resolved IP in hand.
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
				if err != nil {
					return nil, err
				}
				for _, ip := range ips {
					if isBlocked(ip.IP) {
						return nil, fmt.Errorf("%w: %s resolves to %s", ErrBlockedAddress, host, ip.IP)
					}
				}
				// All resolved IPs passed — dial the first one explicitly so
				// a DNS-rebind between our check and the stdlib's own resolve
				// can't slip a private IP in. (Pin the vetted IP.)
				return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
			},
		},
	}
}

// FetchImage GETs url through a guarded client and returns the body,
// capped at maxImageBytes. Returns ErrTooLarge if the source is bigger,
// ErrBlockedAddress if the host resolves to a forbidden IP, ErrRedirect
// on any redirect attempt.
func FetchImage(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ssrf: image fetch status %d", resp.StatusCode)
	}
	// Read one byte past the cap so we can distinguish "exactly cap" from
	// "over cap" — a source that's exactly 10MiB is allowed; 10MiB+1 fails.
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxImageBytes {
		return nil, ErrTooLarge
	}
	return body, nil
}

// blocked reports whether ip is in a forbidden range. The union of:
//   - loopback (127.0.0.0/8, ::1)
//   - private (10/8, 172.16/12, 192.168/16, fc00::/7)
//   - link-local (169.254/16 — AWS/GCP/Azure IMDS lives here)
//   - unspecified (0.0.0.0, ::)
//   - multicast
//
// IsPrivate + IsLoopback + IsLinkLocalUnicast cover the IPv4 + IPv6 forms.
func blocked(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() ||
		ip.IsMulticast() ||
		isIMDS(ip)
}

// isIMDS is belt-and-suspenders for the cloud metadata endpoint. 169.254/16
// is already IsLinkLocalUnicast, but pinning the exact IMDS IP makes the
// intent explicit + survives a future stdlib change to link-local semantics.
func isIMDS(ip net.IP) bool {
	return ip.Equal(net.IPv4(169, 254, 169, 254))
}
