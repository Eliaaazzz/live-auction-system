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
	bidgen := newSteadyBidder(cfg.LumenBaseURL, cfg.TargetAID, cfg.BidRate, rec)
	go bidgen.Run(bidCtx)

	// ── (3) Inject + always-undo ────────────────────────────────────────
	logger.Info("inject")
	rec.InjectedAt = time.Now().UTC()
	env := phases.Env{
		LumenBaseURL:   cfg.LumenBaseURL,
		ToxiproxyURL:   cfg.ToxiproxyURL,
		ComposeProject: "infra",
	}
	undo, err := cfg.Phase.Inject(ctx, env)
	if err != nil {
		_ = bidCancel
		return nil, fmt.Errorf("phase.Inject: %w", err)
	}
	// Uninject is mandatory — defer makes sure it runs even on panic/error.
	defer func() {
		if err := undo(context.Background()); err != nil {
			logger.Error("uninject_failed", "err", err)
			rec.UninjectError = err.Error()
		}
	}()

	// ── (4) Hold ────────────────────────────────────────────────────────
	select {
	case <-time.After(cfg.Duration):
	case <-ctx.Done():
		logger.Warn("ctx_cancelled_during_hold")
	}

	// ── (5) Uninject (via defer above) ──────────────────────────────────
	rec.UninjectedAt = time.Now().UTC()
	logger.Info("uninject_about_to_run_via_defer")

	// Run undo NOW so subsequent recovery wait observes the lifted fault.
	// Defer is the safety net; this explicit call is the happy path.
	if err := undo(ctx); err != nil {
		logger.Error("uninject_explicit_failed", "err", err)
		rec.UninjectError = err.Error()
		// Don't return — defer will try again, and invariants need to run.
	}

	// ── (6) Recovery wait ───────────────────────────────────────────────
	logger.Info("recovery_wait", "for", cfg.RecoverFor)
	select {
	case <-time.After(cfg.RecoverFor):
	case <-ctx.Done():
		logger.Warn("ctx_cancelled_during_recovery")
	}

	// ── (7) Stop steady-bid generator ───────────────────────────────────
	bidCancel()

	// ── (8) Post-snapshot ───────────────────────────────────────────────
	post, err := snapshot(ctx, cfg.LumenBaseURL, cfg.TargetAID)
	if err != nil {
		// Post-snapshot failure is recoverable for the artifact — record the
		// error and proceed with whatever invariants can run without it.
		rec.PostSnapshotError = err.Error()
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
