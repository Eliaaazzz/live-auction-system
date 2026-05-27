// Hidden contract test for PR #24: GetSnapshot must call GET /api/auctions/{id},
// not the previously-wrong GET /api/auctions/{id}/snapshot. Eliaaazzz's PR #24
// CR-suggested test, made executable here so a future "fix" reverting the URL
// fails CI.
package artifact

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHiddenGetSnapshotUsesLumenAuctionRoute(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path
		if r.URL.Path != "/api/auctions/auc_1" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"LIVE","currentPriceCents":"10000","winnerId":"","seq":0,"serverTimeMs":1}`))
	}))
	defer srv.Close()

	snap, err := GetSnapshot(context.Background(), srv.URL, "auc_1")
	if err != nil {
		t.Fatalf("GetSnapshot failed; path=%s err=%v", seen, err)
	}
	if snap == nil {
		t.Fatal("GetSnapshot returned nil snapshot")
	}
	if seen != "/api/auctions/auc_1" {
		t.Errorf("GetSnapshot hit %q, want %q (T2 route — no /snapshot suffix)", seen, "/api/auctions/auc_1")
	}
	if snap.CurrentPriceCents != "10000" {
		t.Errorf("CurrentPriceCents=%q want 10000", snap.CurrentPriceCents)
	}
}

func TestHiddenGetSnapshotRejectsOldRoute(t *testing.T) {
	// Belt-and-suspenders: a test server that ONLY responds to the wrong route
	// must cause GetSnapshot to fail. Catches the reverse regression (someone
	// reverts to /snapshot but a server happens to support it).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auctions/auc_1/snapshot" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"LIVE"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	if _, err := GetSnapshot(context.Background(), srv.URL, "auc_1"); err == nil {
		t.Error("GetSnapshot succeeded against a server that only exposes /snapshot — code is hitting wrong URL again")
	}
}
