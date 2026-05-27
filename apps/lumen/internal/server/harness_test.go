package server

// In-process full-stack harness so the REST/WS hidden tests run without an
// external `make up` stack — and therefore never skip in CI (which provides
// Redis + MySQL). A test may still point at a real deployment via TARGET.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
)

// startTestServer builds a Server backed by a real Redis+MySQL store, starts the
// Pub/Sub broadcaster + persistence worker, and serves the routes via httptest.
// Returns the base URL (http://…; WS dials derive ws://). Skips only if the
// backing infra is genuinely unavailable (CI always provides it).
func startTestServer(t *testing.T) (string, *Server) {
	st := fullStore(t)
	srv := &Server{
		cfg: config.Config{
			JWTSecret:      "test-secret-not-default",
			FrontendOrigin: "http://test.local",
			AppEnv:         "dev",
			EnableDevLogin: true,
			AISidecarURL:   "http://127.0.0.1:0", // unused by these tests
		},
		st:         st,
		hub:        newHub(),
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	// T7 §4.2: nil auctioneer in test harness — none of the harness
	// tests assert AI commentary; the nil-check in subscribe/timer
	// keeps the path inert. Real Server.Serve wires a fresh one.
	srv.auctioneer = nil
	ctx, cancel := context.WithCancel(context.Background())
	go srv.hub.subscribe(ctx, st, srv.auctioneer)
	go runPersistenceWorker(ctx, st)
	go runTimerWorker(ctx, st, srv.auctioneer)

	mux := http.NewServeMux()
	srv.routes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(func() {
		ts.Close()
		cancel()
	})
	return ts.URL, srv
}
