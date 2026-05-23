// Package artifact owns the per-drill recorder + JSON output.
//
// Artifact shape is the assertable evidence per V9 §9 — fully machine-parseable
// so dashboards / reports / CI gates can consume it.
package artifact

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/invariants"
)

// Snapshot mirrors the shape returned by GET /api/auctions/{id}/snapshot.
type Snapshot struct {
	Status            string `json:"status"`
	CurrentPriceCents string `json:"currentPriceCents"`
	WinnerID          string `json:"winnerId"`
	Seq               int64  `json:"seq"`
	ServerTimeMs      int64  `json:"serverTimeMs"`
}

// Recorder is the in-memory aggregator the orchestrator writes to as the
// drill runs. It's thread-safe so the bidgen goroutine can record alongside
// the orchestrator main loop.
type Recorder struct {
	Phase     string `json:"phase"`
	AuctionID string `json:"auction_id"`

	InjectedAt        time.Time `json:"injected_at"`
	UninjectedAt      time.Time `json:"uninjected_at"`
	UninjectError     string    `json:"uninject_error,omitempty"`
	PostSnapshotError string    `json:"post_snapshot_error,omitempty"`

	PreSnapshot  *Snapshot `json:"pre_snapshot"`
	PostSnapshot *Snapshot `json:"post_snapshot,omitempty"`

	// Per-bid record of every steady-bid attempt during the drill window.
	Bids []BidRecord `json:"bids"`

	// Aggregated counts (derived from Bids; convenience for fast scanning)
	AcceptedCount    int            `json:"accepted_count"`
	TerminalCount    int            `json:"terminal_count"`
	RejectCodeCounts map[string]int `json:"reject_code_counts"`

	// Latencies (parallel to Bids; pre-computed for invariants)
	AckLatencies []time.Duration `json:"-"`

	FirstOKAfterUninject *time.Time `json:"first_ok_after_uninject,omitempty"`

	Invariants          []invariants.Result `json:"invariants"`
	AllInvariantsPassed bool                `json:"all_invariants_passed"`

	mu sync.Mutex
}

type BidRecord struct {
	At       time.Time `json:"at"`
	Code     string    `json:"code"`
	Duration string    `json:"duration"` // string form for JSON readability
	Error    string    `json:"error,omitempty"`
}

func NewRecorder(phase, aid string) *Recorder {
	return &Recorder{
		Phase: phase, AuctionID: aid,
		RejectCodeCounts: map[string]int{},
	}
}

// RecordBid is called by bidgen on every attempt — concurrent-safe.
func (r *Recorder) RecordBid(at time.Time, code string, dur time.Duration, errMsg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Bids = append(r.Bids, BidRecord{
		At: at, Code: code, Duration: dur.String(), Error: errMsg,
	})
	r.AckLatencies = append(r.AckLatencies, dur)
	switch {
	case code == "OK_ACCEPTED":
		r.AcceptedCount++
		// First OK after uninject? (Uninject timestamp may not be set yet if
		// bid was during inject phase — skip in that case.)
		if !r.UninjectedAt.IsZero() && at.After(r.UninjectedAt) && r.FirstOKAfterUninject == nil {
			t := at
			r.FirstOKAfterUninject = &t
		}
	case code == "OK_SOLD" || code == "OK_NO_BID" || code == "OK_CANCELLED":
		r.TerminalCount++
	default:
		r.RejectCodeCounts[code]++
	}
}

// Write serializes the recorder to JSON at path. Creates parent dirs.
func Write(path string, r *Recorder) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// GetSnapshot calls the snapshot endpoint. Lives in artifact so both the
// orchestrator and the invariants can share it.
func GetSnapshot(ctx context.Context, baseURL, aid string) (*Snapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/auctions/%s/snapshot", baseURL, aid), nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("snapshot status %d", resp.StatusCode)
	}
	var s Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &s, nil
}
