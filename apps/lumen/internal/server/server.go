// Package server wires the lumen process. For T1 `--mode=all` runs api + WS
// gateway + bid-engine + persistence in one process; the mode switches keep the
// seam so T5 can split gateway out horizontally.
package server

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof on http.DefaultServeMux only — served on the loopback PPROF_ADDR below, never the public mux
	"net/netip"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

type Server struct {
	cfg        config.Config
	st         *store.Store
	hub        *Hub
	httpClient *http.Client
	// T7 §4.2: LLM auctioneer trigger hooks. Always set after Serve()
	// initializes (nil-safe before that). See auctioneer.go.
	auctioneer *AuctioneerHooks
	// metrics is the T8 in-process observability registry (V9 §4.2 SLO
	// instruments). One per process; the load harness scrapes /metrics, the
	// bid hot path Observes.
	metrics *metrics.Registry
}

// isLoopbackHostPort reports whether addr ("host:port") binds ONLY the loopback
// interface. An empty host (":6060"), "0.0.0.0", "::", or any routable IP binds a
// public interface, so pprof on such an addr is refused — it can never be exposed
// by a deploy typo (PDGGK review #235). A non-IP host other than "localhost" (a
// DNS name that could resolve routably) is also treated as non-loopback.
func isLoopbackHostPort(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil || host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return ip.IsLoopback()
}

// Serve connects datastores, starts the selected mode's background workers, and
// serves HTTP (REST + WS + static web) until ctx is cancelled.
func Serve(ctx context.Context, cfg config.Config, mode string) error {
	timerDisabled, err := timerDisabledByChaos(cfg, mode)
	if err != nil {
		return err
	}

	st, err := store.NewWithRedisPassword(ctx, cfg.RedisAddr, cfg.RedisPassword, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	s := &Server{
		cfg:        cfg,
		st:         st,
		hub:        newHub(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
		metrics:    metrics.New(),
	}
	// T7 §4.2: AI auctioneer trigger hooks. Always initialized so any
	// mode that hosts the bid path / start path / timer can call into
	// them — the goroutines fire only on events from those modes, so
	// idle modes have zero overhead.
	s.auctioneer = NewAuctioneerHooks(cfg.AISidecarURL, s.hub, s.httpClient)

	switch mode {
	case "all", "gateway":
		// goSupervised: a panic in a long-lived worker must NOT crash the gateway
		// (net/http only recovers request-handler panics). Recover + restart, count
		// goroutinePanics for alerting (spec deep-review: 异常兜底/稳定性).
		goSupervised(ctx, "subscribe", s.metrics, func(c context.Context) {
			s.hub.subscribe(c, st, s.auctioneer, s.metrics)
		})
	}
	switch mode {
	case "all", "pg-writer":
		goSupervised(ctx, "persistence", s.metrics, func(c context.Context) {
			runPersistenceWorker(c, st)
		})
	}
	switch mode {
	case "all", "timer":
		// LUMEN_CHAOS_DISABLE_TIMER is the T9 timer-fault knob: when set to "1",
		// the Timer Worker goroutine is skipped at startup so the chaos drill
		// can observe LIVE auctions outliving their endAtMs. The drill toggles
		// the env via `docker compose up -d` with `-e` override. The startup
		// guard only allows that in dev; non-dev fails fast. Anything other than
		// "1" (including missing) keeps the timer on.
		if !timerDisabled {
			goSupervised(ctx, "timer", s.metrics, func(c context.Context) {
				runTimerWorker(c, st, s.auctioneer, s.metrics)
			})
		} else {
			log.Printf("lumen: LUMEN_CHAOS_DISABLE_TIMER=1 — Timer Worker NOT started (T9 chaos drill)")
		}
	}

	// Loopback-only pprof for crash forensics (heap / goroutine profiles). The
	// 2026-06-07 load test crashed the gateway at ~15.7k conns with /metrics
	// zeroed and no captured cause; pprof + GODEBUG=gctrace pin OOM-vs-panic. It
	// serves http.DefaultServeMux (where net/http/pprof registered) on a PRIVATE
	// addr so it is never reachable from the public mux/EIP. Opt-in: empty
	// PPROF_ADDR (the default outside the prod compose) leaves it off entirely.
	// CODE-ENFORCED loopback (PDGGK review #235): a misconfigured PPROF_ADDR
	// (":6060", "0.0.0.0:6060", a public IP) would expose /debug/pprof — info
	// disclosure + DoS — so a non-loopback bind is REFUSED here, not just
	// discouraged by deploy convention.
	if addr := strings.TrimSpace(os.Getenv("PPROF_ADDR")); addr != "" {
		if !isLoopbackHostPort(addr) {
			log.Printf("lumen: PPROF_ADDR=%q is NOT loopback — pprof DISABLED (refusing to expose /debug/pprof on a routable interface)", addr)
		} else {
			go func() {
				log.Printf("lumen: pprof (loopback forensics) on %s", addr)
				if err := http.ListenAndServe(addr, nil); err != nil {
					log.Printf("lumen: pprof listener on %s: %v", addr, err)
				}
			}()
		}
	}

	mux := http.NewServeMux()
	s.routes(mux)

	httpSrv := &http.Server{Addr: cfg.HTTPAddr, Handler: mux}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("lumen mode=%s listening on %s (env=%s, devLogin=%v)", mode, cfg.HTTPAddr, cfg.AppEnv, cfg.EnableDevLogin)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func timerDisabledByChaos(cfg config.Config, mode string) (bool, error) {
	if mode != "all" && mode != "timer" {
		return false, nil
	}
	if os.Getenv("LUMEN_CHAOS_DISABLE_TIMER") != "1" {
		return false, nil
	}
	if cfg.AppEnv != "dev" {
		return false, fmt.Errorf("LUMEN_CHAOS_DISABLE_TIMER=1 is only allowed when APP_ENV=dev")
	}
	return true, nil
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /version", s.handleVersion)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("POST /admin/metrics/reset", s.handleMetricsReset)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/dev-login", s.handleDevLogin)
	mux.HandleFunc("POST /api/products", s.handleCreateProduct)
	mux.HandleFunc("POST /api/facts/draft", s.handleFactsDraft)
	mux.HandleFunc("GET /api/auctions", s.handleListAuctions)
	mux.HandleFunc("POST /api/auctions", s.handleCreateAuction)
	mux.HandleFunc("POST /api/recommend-mode", s.handleRecommendMode) // issue #114: heuristic mode recommender
	mux.HandleFunc("GET /api/auctions/{id}", s.handleGetAuction)
	mux.HandleFunc("GET /api/auctions/{id}/stream", s.handleGetAuctionStream)
	mux.HandleFunc("PATCH /api/auctions/{id}", s.handlePatchAuction)
	mux.HandleFunc("GET /api/auctions/{id}/events-count", s.handleEventsCount)
	mux.HandleFunc("GET /api/auctions/{id}/leaderboard", s.handleLeaderboard)
	mux.HandleFunc("POST /api/auctions/{id}/bids", s.handlePlaceBidHTTP)
	mux.HandleFunc("GET /api/auctions/{id}/evidence", s.handleEvidence)
	mux.HandleFunc("GET /api/auctions/{id}/order", s.handleGetOrder)
	mux.HandleFunc("POST /api/auctions/{id}/freeze", s.handleFreeze)
	mux.HandleFunc("POST /api/auctions/{id}/start", s.handleStart)
	mux.HandleFunc("POST /api/auctions/{id}/cancel", s.handleCancel)
	mux.HandleFunc("GET /api/auctions/{id}/prequalify-recommendation", s.handlePrequalifyRecommendation)
	mux.HandleFunc("POST /api/auctions/{id}/spawn-formal", s.handleSpawnFormal) // issue #114 phase 6
	mux.HandleFunc("POST /api/auctions/{id}/pay", s.handlePayOrder)
	mux.HandleFunc("POST /api/upload", s.handleUpload)
	mux.HandleFunc("GET /ws", s.handleWS)

	// Uploaded product media (see upload.go). Immutable names → long cache.
	mux.Handle("GET /uploads/", cacheImmutable(
		http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadDir())))))

	webDir := os.Getenv("WEB_DIR")
	if webDir == "" {
		webDir = "./web"
	}
	mux.Handle("/", spaFileServer(webDir))
}

// cacheImmutable marks responses as long-lived: upload names embed a
// timestamp + random token, so a URL's content never changes.
func cacheImmutable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		next.ServeHTTP(w, r)
	})
}

// spaFileServer serves static assets from webDir, falling back to index.html
// for any unmatched path so the React app's client-side routes (BrowserRouter:
// /room/:id, /evidence/:id, /preview/*) resolve on direct load + refresh, not
// just in-app navigation. The API / WS / metrics routes are registered on the
// mux before this catch-all, so they always take precedence. Existing files
// (the hashed /assets/* bundles) are served as-is; only genuinely-missing paths
// fall through to the SPA entry point.
func spaFileServer(webDir string) http.Handler {
	fileServer := http.FileServer(http.Dir(webDir))
	index := filepath.Join(webDir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never fall through to the SPA for the API / WS namespaces. An unmatched
		// /api/* or /ws path is a real 404 — without this guard it returned
		// index.html with 200 and the frontend tried to JSON.parse HTML. #109.
		if p := r.URL.Path; strings.HasPrefix(p, "/api/") || p == "/api" || strings.HasPrefix(p, "/ws") {
			writeJSON(w, http.StatusNotFound, map[string]string{"code": "ERR_NOT_FOUND"})
			return
		}
		if r.URL.Path != "/" {
			// path.Clean on a rooted copy neutralizes any ../ traversal before
			// we touch the filesystem; filepath.Join then keeps us under webDir.
			rel := filepath.FromSlash(path.Clean("/" + r.URL.Path))
			if fi, err := os.Stat(filepath.Join(webDir, rel)); err == nil && !fi.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// index.html must NOT be heuristically cached: it references the current
		// hashed /assets/*.js bundle, which changes every build. A stale cached
		// index.html points at an old hash that 404s after a redeploy → blank
		// page. no-cache forces revalidation so the browser always gets the HTML
		// that matches the deployed bundle. (The hashed assets themselves are
		// safe to cache — their URL changes when content changes.)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}
