// Package server wires the lumen process. For T1 `--mode=all` runs api + WS
// gateway + bid-engine + persistence in one process; the mode switches keep the
// seam so T5 can split gateway out horizontally.
package server

import (
	"context"
	"log"
	"net/http"
	"os"
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

// Serve connects datastores, starts the selected mode's background workers, and
// serves HTTP (REST + WS + static web) until ctx is cancelled.
func Serve(ctx context.Context, cfg config.Config, mode string) error {
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.EvidenceHMACKey)
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
		go s.hub.subscribe(ctx, st, s.auctioneer, s.metrics)
	}
	switch mode {
	case "all", "pg-writer":
		go runPersistenceWorker(ctx, st)
	}
	switch mode {
	case "all", "timer":
		// LUMEN_CHAOS_DISABLE_TIMER is the T9 timer-fault knob: when set to "1",
		// the Timer Worker goroutine is skipped at startup so the chaos drill
		// can observe LIVE auctions outliving their endAtMs. The drill toggles
		// the env via `docker compose up -d` with `-e` override; in prod the
		// var is unset and behaviour is unchanged. Anything other than "1"
		// (including missing) keeps the timer on — fail-closed.
		if os.Getenv("LUMEN_CHAOS_DISABLE_TIMER") != "1" {
			go runTimerWorker(ctx, st, s.auctioneer, s.metrics)
		} else {
			log.Printf("lumen: LUMEN_CHAOS_DISABLE_TIMER=1 — Timer Worker NOT started (T9 chaos drill)")
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

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("POST /api/dev-login", s.handleDevLogin)
	mux.HandleFunc("POST /api/products", s.handleCreateProduct)
	mux.HandleFunc("POST /api/facts/draft", s.handleFactsDraft)
	mux.HandleFunc("POST /api/auctions", s.handleCreateAuction)
	mux.HandleFunc("GET /api/auctions/{id}", s.handleGetAuction)
	mux.HandleFunc("GET /api/auctions/{id}/events-count", s.handleEventsCount)
	mux.HandleFunc("GET /api/auctions/{id}/leaderboard", s.handleLeaderboard)
	mux.HandleFunc("GET /api/auctions/{id}/evidence", s.handleEvidence)
	mux.HandleFunc("POST /api/auctions/{id}/freeze", s.handleFreeze)
	mux.HandleFunc("POST /api/auctions/{id}/start", s.handleStart)
	mux.HandleFunc("POST /api/auctions/{id}/cancel", s.handleCancel)
	mux.HandleFunc("GET /ws", s.handleWS)

	webDir := os.Getenv("WEB_DIR")
	if webDir == "" {
		webDir = "./web"
	}
	mux.Handle("/", http.FileServer(http.Dir(webDir)))
}
