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
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

type Server struct {
	cfg        config.Config
	st         *store.Store
	hub        *Hub
	httpClient *http.Client
}

// Serve connects datastores, starts the selected mode's background workers, and
// serves HTTP (REST + WS + static web) until ctx is cancelled.
func Serve(ctx context.Context, cfg config.Config, mode string) error {
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN)
	if err != nil {
		return err
	}
	defer st.Close()

	s := &Server{
		cfg:        cfg,
		st:         st,
		hub:        newHub(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}

	switch mode {
	case "all", "gateway":
		go s.hub.subscribe(ctx, st)
	}
	switch mode {
	case "all", "pg-writer":
		go runPersistenceWorker(ctx, st)
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
	mux.HandleFunc("GET /ws", s.handleWS)

	webDir := os.Getenv("WEB_DIR")
	if webDir == "" {
		webDir = "./web"
	}
	mux.Handle("/", http.FileServer(http.Dir(webDir)))
}
