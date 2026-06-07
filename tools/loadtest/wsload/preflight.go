package main

// Preflight is a small connection-path probe that runs *before* the full 10k
// ramp. It exists because of issue #231: every failed Beijing 10k run
// (Locust public, wsload public) failed the same way — connections could not
// be *established* over a public-IP self-dial path — while the same production
// binary held 10k cleanly over loopback (Test C) and the private IP (Test D)
// with sub-ms server-side ack. A path that cannot keep ~20 sockets up will
// never hold 10k, so spending a multi-minute ramp to discover that is pure
// waste (and a live demo that hangs in front of a mentor is worse). The
// preflight catches the broken path in seconds and, when the target is a raw
// public IP, names the most likely cause (NAT hairpin self-dial) and the fix.

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// preflightMode controls what wsload does when the probe judges the path unfit.
type preflightMode int

const (
	preflightAbort preflightMode = iota // default: refuse to start the ramp
	preflightWarn                       // log loudly but proceed anyway
	preflightOff                        // skip the probe entirely
)

// parsePreflightMode maps the -preflight flag to a mode. Empty == abort (the
// safe default); off accepts the usual disable synonyms.
func parsePreflightMode(s string) (preflightMode, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "abort":
		return preflightAbort, nil
	case "warn":
		return preflightWarn, nil
	case "off", "false", "no", "skip", "0":
		return preflightOff, nil
	default:
		return preflightAbort, fmt.Errorf("invalid -preflight %q (want abort|warn|off)", s)
	}
}

// hostClass classifies the -host target so the diagnosis can be specific. The
// #231 footgun is dialing a *public IP literal* from a box inside the gateway's
// own host/VPC — most clouds (Alibaba/Volcengine ECS) will not hairpin a host
// back to its own EIP. Loopback and private targets passed at 10k, and a real
// LB *hostname* is the correct production path, so only a public IP literal
// earns the hairpin warning.
type hostClass int

const (
	hostUnknown hostClass = iota
	hostLoopback
	hostPrivate
	hostPublicIP
	hostName
)

func (c hostClass) String() string {
	switch c {
	case hostLoopback:
		return "loopback"
	case hostPrivate:
		return "private"
	case hostPublicIP:
		return "public-ip"
	case hostName:
		return "hostname"
	default:
		return "unknown"
	}
}

// classifyHost extracts the host from a ws://host:port / wss://host / bare
// host[:port] value and classifies it. It never resolves DNS (that would make
// a pure helper do network I/O); a non-IP host is reported as hostName, which
// is intentionally *not* flagged — an LB/domain is the recommended target.
func classifyHost(rawHost string) (hostClass, string) {
	h := strings.TrimSpace(rawHost)
	if strings.Contains(h, "://") {
		if u, err := url.Parse(h); err == nil && u.Host != "" {
			h = u.Host
		}
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]") // unwrap IPv6 literal brackets
	if h == "" {
		return hostUnknown, ""
	}
	if strings.EqualFold(h, "localhost") {
		return hostLoopback, h
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return hostName, h
	}
	switch {
	case ip.IsLoopback():
		return hostLoopback, h
	case ip.IsPrivate(), ip.IsLinkLocalUnicast(), isCGNAT(ip):
		return hostPrivate, h
	default:
		return hostPublicIP, h
	}
}

// isCGNAT reports whether ip is in RFC 6598 shared address space
// (100.64.0.0/10). net.IP.IsPrivate does not cover it, but it is just as
// non-routable from outside the carrier/VPC as RFC 1918.
func isCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

// preflightConfig is the probe's tunables, mirrored from the -preflight* flags.
type preflightConfig struct {
	mode   preflightMode
	conns  int
	minOK  float64
	budget time.Duration
}

// preflightResult is what the probe observed; the pass/fail decision and the
// human diagnosis are evaluatePreflight's job (kept pure for unit testing).
type preflightResult struct {
	attempted  int
	connectOK  int
	framesSeen int    // probes that received at least one server frame
	sampleErr  string // one representative dial error, collapsed
}

func (r preflightResult) okFraction() float64 {
	if r.attempted == 0 {
		return 0
	}
	return float64(r.connectOK) / float64(r.attempted)
}

// evaluatePreflight decides whether the probed path is healthy enough to spend
// a full ramp on, and returns a human diagnosis. Pure (no I/O) so the decision
// and the messaging are unit-tested without a live server.
func evaluatePreflight(res preflightResult, cfg preflightConfig, class hostClass, host string) (pass bool, diag string) {
	frac := res.okFraction()
	if res.attempted > 0 && frac >= cfg.minOK {
		if res.framesSeen == 0 {
			return true, fmt.Sprintf(
				"preflight OK: %d/%d connects (%.0f%%) but 0 server frames — auction may be idle/expired; proceeding",
				res.connectOK, res.attempted, frac*100)
		}
		return true, fmt.Sprintf(
			"preflight OK: %d/%d connects (%.0f%%), server frames flowing",
			res.connectOK, res.attempted, frac*100)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "preflight FAIL: only %d/%d probe connects (%.0f%%, need >=%.0f%%) at low concurrency",
		res.connectOK, res.attempted, frac*100, cfg.minOK*100)
	if res.sampleErr != "" {
		fmt.Fprintf(&b, "; sample dial error: %s", res.sampleErr)
	}
	b.WriteString("\n  A path that drops connections at this scale will not hold 10k — this is a")
	b.WriteString("\n  network/topology problem, not the Redis-Lua bid path (issue #231).")
	if class == hostPublicIP {
		fmt.Fprintf(&b, "\n  Target %s is a PUBLIC IP literal. If this load box sits in the gateway's", host)
		b.WriteString("\n  own host/VPC this is almost certainly NAT hairpin self-dial — clouds")
		b.WriteString("\n  (Alibaba/Volcengine ECS) commonly will not route a host back to its own EIP.")
		b.WriteString("\n  Fix: dial the gateway PRIVATE IP or a PRIVATE LB from an independent in-VPC")
		b.WriteString("\n  worker (Test C/D passed at 10k that way). See")
		b.WriteString("\n  docs/runbooks/beijing-tier1-10k-demo.md.")
	} else {
		b.WriteString("\n  Check: LB WebSocket upgrade + tunnel timeout, gateway nofile/somaxconn,")
		b.WriteString("\n  security-group/firewall rules, and that the load worker is near the target.")
	}
	return false, b.String()
}

// runPreflight opens a small concurrent burst of probe connections, does
// ROOM_JOIN, and checks whether the path can both establish connections and
// deliver a frame at low concurrency. It uses its own short-handshake dialer so
// a wedged path fails fast within the probe budget instead of inheriting the
// main dialer's 15s handshake timeout.
func runPreflight(host, aid string, tokens []string, cfg preflightConfig) preflightResult {
	n := cfg.conns
	if n > len(tokens) {
		n = len(tokens)
	}
	if n < 1 {
		n = 1
	}
	pd := &websocket.Dialer{
		HandshakeTimeout: cfg.budget,
		ReadBufferSize:   1024,
		WriteBufferSize:  1024,
	}
	// Per-connection op window for the ROOM_JOIN write + first-frame read,
	// computed *after* each dial so a slow handshake doesn't eat the read
	// budget, and bounded so a wedged socket can't hold the connection (or its
	// goroutine) open past the probe.
	opWindow := cfg.budget
	if opWindow > 5*time.Second {
		opWindow = 5 * time.Second
	}

	var (
		okCount    atomic.Int64
		frameCount atomic.Int64
		mu         sync.Mutex
		sampleErr  string
		wg         sync.WaitGroup
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(tok string) {
			defer wg.Done()
			wsURL := host + "/ws?token=" + url.QueryEscape(tok)
			c, _, err := pd.Dial(wsURL, nil)
			if err != nil {
				mu.Lock()
				if sampleErr == "" {
					sampleErr = collapseDialErr(err)
				}
				mu.Unlock()
				return
			}
			okCount.Add(1)
			defer func() { _ = c.Close() }()
			deadline := time.Now().Add(opWindow)
			_ = c.SetWriteDeadline(deadline)
			if err := c.WriteMessage(websocket.TextMessage,
				envelope("ROOM_JOIN", aid, map[string]string{"auctionId": aid})); err != nil {
				return
			}
			_ = c.SetReadDeadline(deadline)
			if _, _, err := c.ReadMessage(); err == nil {
				frameCount.Add(1)
			}
		}(tokens[i])
	}
	wg.Wait()
	return preflightResult{
		attempted:  n,
		connectOK:  int(okCount.Load()),
		framesSeen: int(frameCount.Load()),
		sampleErr:  sampleErr,
	}
}

// collapseDialErr trims the volatile per-call dial address out of a dial error
// so repeated errors group cleanly. Shared by the preflight and the main run's
// stats so both report dial failures identically.
func collapseDialErr(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ": "); i > 0 && len(msg) > 60 {
		msg = msg[strings.LastIndex(msg, ": ")+2:]
	}
	return msg
}
