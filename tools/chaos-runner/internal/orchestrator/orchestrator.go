// Package orchestrator runs the per-drill lifecycle:
//
//  1. Snapshot pre-state
//  2. Start steady-bid generator (records every attempt + latency)
//  3. Inject fault (phase.Inject returns undo func)
//  4. Hold for Duration
//  5. Uninject (defer-protected)
//  6. Wait RecoverFor
//  7. Stop steady-bid generator
//  8. Snapshot post-state
//  9. Run all invariants (For(phase) + common)
//  10. Emit chaos-run-<phase>-<timestamp>.json artifact
//
// The orchestrator owns the contextual data invariants need; phases never
// touch invariant state directly.
package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/artifact"
	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/invariants"
	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/phases"
)

type Config struct {
	Phase        phases.Phase
	Duration     time.Duration
	RecoverFor   time.Duration
	TargetAID    string
	BidRate      int
	ArtifactDir  string
	LumenBaseURL string
	ToxiproxyURL string
}

type Result struct {
	ArtifactPath        string
	AllInvariantsPassed bool
}

func Run(ctx context.Context, cfg Config) (*Result, error) {
	logger := slog.With("phase", cfg.Phase.Name(), "aid", cfg.TargetAID)
	logger.Info("orchestrator.start", "duration", cfg.Duration, "recover_for", cfg.RecoverFor)

	rec := artifact.NewRecorder(cfg.Phase.Name(), cfg.TargetAID)

	// ── (1) Pre-snapshot ───────────────────────────────────────────────
	pre, err := snapshot(ctx, cfg.LumenBaseURL, cfg.TargetAID)
	if err != nil {
		// A pre-snapshot failure is fatal: we can't measure drift without it.
		return nil, fmt.Errorf("pre-snapshot: %w", err)
	}
	rec.PreSnapshot = pre
	logger.Info("pre-snapshot", "seq", pre.Seq, "status", pre.Status)

	// ── (2) Steady-bid generator (background) ───────────────────────────
	bidCtx, bidCancel := context.WithCancel(ctx)
	defer bidCancel()
	bidDone := make(chan struct{})
	bidgen := newSteadyBidder(cfg.LumenBaseURL, cfg.TargetAID, cfg.BidRate, rec)
	go func() {
		defer close(bidDone)
		bidgen.Run(bidCtx)
	}()

	// ── (3) Inject + always-undo ────────────────────────────────────────
	logger.Info("inject")
	rec.SetInjectedAt(time.Now().UTC())
	env := phases.Env{
		LumenBaseURL:   cfg.LumenBaseURL,
		ToxiproxyURL:   cfg.ToxiproxyURL,
		ComposeProject: "infra",
	}
	rawUndo, err := cfg.Phase.Inject(ctx, env)
	if err != nil {
		_ = bidCancel
		return nil, fmt.Errorf("phase.Inject: %w", err)
	}
	// PDGGK PR #24 CR: previous code called undo twice on happy path (defer +
	// explicit). For phases whose uninject isn't idempotent (toxiproxy
	// re-enable, container restart that races with another caller), a double
	// call can mask recovery failures or flip state twice. sync.Once collapses
	// both call sites to a single execution; the defer becomes a no-op once
	// the explicit happy-path call ran.
	var (
		undoOnce sync.Once
		undoErr  error
	)
	undo := func(c context.Context) error {
		undoOnce.Do(func() { undoErr = rawUndo(c) })
		return undoErr
	}
	// Uninject is mandatory — defer makes sure it runs even on panic/error.
	// (When the explicit undo on line 110 succeeded, this defer is a no-op.)
	defer func() {
		if err := undo(context.Background()); err != nil {
			logger.Error("uninject_failed", "err", err)
			rec.SetUninjectError(err.Error())
		}
	}()

	// ── (4) Hold ────────────────────────────────────────────────────────
	select {
	case <-time.After(cfg.Duration):
	case <-ctx.Done():
		logger.Warn("ctx_cancelled_during_hold")
	}

	// ── (5) Uninject (explicit happy path — defer is the safety net) ───
	// SetUninjectedAt routes through the recorder mutex (PDGGK CR P1-3): the
	// bidder goroutine reads UninjectedAt in RecordBid to classify "during
	// injection" samples; a plain assignment here would race with that read.
	rec.SetUninjectedAt(time.Now().UTC())
	logger.Info("uninject")
	if err := undo(ctx); err != nil {
		logger.Error("uninject_explicit_failed", "err", err)
		rec.SetUninjectError(err.Error())
		// Don't return — invariants still need to run on whatever state we have.
	}

	// ── (6) Recovery wait ───────────────────────────────────────────────
	logger.Info("recovery_wait", "for", cfg.RecoverFor)
	select {
	case <-time.After(cfg.RecoverFor):
	case <-ctx.Done():
		logger.Warn("ctx_cancelled_during_recovery")
	}

	// ── (7) Stop steady-bid generator AND wait for it to exit, so we read
	//        rec.AckLatencies after all writes are flushed (previously the
	//        invariant context captured a partial/stale slice → p50/p95/p99
	//        showed 0 even with 100+ real samples).
	bidCancel()
	select {
	case <-bidDone:
	case <-time.After(3 * time.Second):
		logger.Warn("bidgen did not exit within 3s; reading possibly-stale recorder state")
	}

	// ── (8) Post-snapshot ───────────────────────────────────────────────
	post, err := snapshot(ctx, cfg.LumenBaseURL, cfg.TargetAID)
	if err != nil {
		// Post-snapshot failure is recoverable for the artifact — record the
		// error and proceed with whatever invariants can run without it.
		rec.SetPostSnapshotError(err.Error())
		logger.Warn("post-snapshot failed", "err", err)
	} else {
		rec.PostSnapshot = post
		logger.Info("post-snapshot", "seq", post.Seq, "status", post.Status)
	}

	// ── (9) Invariants ──────────────────────────────────────────────────
	parseDeadline := func(s string) time.Duration {
		// "30s" → 30s; "0s" → 0
		if d, err := time.ParseDuration(s); err == nil {
			return d
		}
		return 30 * time.Second
	}
	invCtx := buildInvariantContext(ctx, rec, parseDeadline(cfg.Phase.RecoveryDeadline()))
	invEnv := invariants.Env{
		LumenBaseURL:        cfg.LumenBaseURL,
		AuctionID:           cfg.TargetAID,
		PreSnapshotKey:      "pre",
		PostSnapshotKey:     "post",
		DuringEventsKey:     "during",
		RecoveryDeadlineKey: "recovery_deadline",
	}
	invs := invariants.For(cfg.Phase.Name(), invEnv)
	allPassed := true
	for _, inv := range invs {
		r := inv.Check(invCtx)
		rec.Invariants = append(rec.Invariants, r)
		if !r.Passed {
			allPassed = false
		}
		logger.Info("invariant", "name", r.Name, "passed", r.Passed, "msg", r.Message)
	}
	rec.AllInvariantsPassed = allPassed

	// ── (10) Emit artifact ──────────────────────────────────────────────
	path := filepath.Join(cfg.ArtifactDir,
		fmt.Sprintf("chaos-run-%s-%s.json",
			cfg.Phase.Name(),
			rec.InjectedAt.Format("20060102T150405Z")))
	if err := artifact.Write(path, rec); err != nil {
		return nil, fmt.Errorf("write artifact: %w", err)
	}
	logger.Info("artifact.written", "path", path)
	return &Result{
		ArtifactPath:        path,
		AllInvariantsPassed: allPassed,
	}, nil
}

// buildInvariantContext stuffs the pre/post snapshots + during-events tally
// into a context for invariants to read. Keeps the invariant interface
// dependency-light.
func buildInvariantContext(parent context.Context, rec *artifact.Recorder, recoveryDeadline time.Duration) context.Context {
	c := parent
	if rec.PreSnapshot != nil {
		c = context.WithValue(c, snapKey("pre", "seq"), rec.PreSnapshot.Seq)
		c = context.WithValue(c, snapKey("pre", "status"), rec.PreSnapshot.Status)
	}
	if rec.PostSnapshot != nil {
		c = context.WithValue(c, snapKey("post", "seq"), rec.PostSnapshot.Seq)
		c = context.WithValue(c, snapKey("post", "status"), rec.PostSnapshot.Status)
	}
	for code, n := range rec.RejectCodeCounts {
		c = context.WithValue(c, evtKey("during", "BID_REJECTED::"+code), n)
	}
	c = context.WithValue(c, evtKey("during", "BID_ACCEPTED"), rec.AcceptedCount)
	// PDGGK PR #24 CR P1-2: surface accepts-during-injection so invariants can
	// prove "bidding continued under fault" rather than aggregating across the
	// whole drill (which silently passes when 0 accepts happen during inject
	// but recovery accepts arrive post-uninject).
	c = context.WithValue(c, evtKey("during", "BID_ACCEPTED_INJECTION_WINDOW"), rec.AcceptedDuringInjection)
	c = context.WithValue(c, evtKey("during", "TERMINAL"), rec.TerminalCount)
	if rec.FirstOKAfterUninject != nil {
		c = context.WithValue(c, recKey("during", "first_ok_after_uninject"), rec.FirstOKAfterUninject)
	}
	c = context.WithValue(c, recKey("during", "uninject_at"), rec.UninjectedAt)
	c = context.WithValue(c, "recovery_deadline", recoveryDeadline)
	c = context.WithValue(c, latencyKey("during"), rec.AckLatencies)
	c = context.WithValue(c, toleranceKey("during"), 200*time.Millisecond) // TODO: per-phase tolerance
	return c
}

// Tiny helpers so the keys here match invariants/*.go.
func snapKey(base, f string) string { return base + "::snap::" + f }
func evtKey(base, t string) string  { return base + "::events::" + t }
func recKey(base, s string) string  { return base + "::recovery::" + s }
func latencyKey(b string) string    { return b + "::latencies" }
func toleranceKey(b string) string  { return b + "::tolerance" }

// snapshot wraps the snapshot endpoint call (same shape as ROOM_SNAPSHOT WS
// event per V9 §6 shared $ref).
type snap = artifact.Snapshot

func snapshot(ctx context.Context, baseURL, aid string) (*snap, error) {
	// Delegated to artifact package which has the http client.
	return artifact.GetSnapshot(ctx, baseURL, aid)
}

// (unused — placeholder kept to satisfy the `_ = strconv` import if a future
// version of the package needs numeric conversion)
var _ = strconv.Itoa
