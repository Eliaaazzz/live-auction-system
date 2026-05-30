// Command lumen is the single Lumen Auction backend binary, subcommand-dispatched:
//
//	lumen serve --mode=all|api|gateway|bid-engine|timer|pg-writer
//	lumen seed
//	lumen verify [--auction <id>]            (T6 unified: 3-way diff + hash chain; exit!=0 on mismatch or break)
//	lumen verify-evidence [--auction <id>]   (T4 hash-chain only; same chain check, no 3-way diff)
//	lumen e2e            (drives TARGET, default http://localhost:8080)
//	lumen demo-auction   (drives TARGET; T10 §12 nodes 4-5 — anti-snipe extend → hammer → evidence)
//	lumen perf-smoke     (drives TARGET; ack/broadcast p95 floor-check)
//	lumen load           (drives TARGET; T8 P0 gate — 500 connected + 50 active, asserts §4.2 budgets)
//	lumen chaos --phase=<setup|bid-expect|connect-fails|state-expect|catchup-expect|wait-events>
//	                    (drives TARGET; T9 fault-drill building blocks composed by `make chaos PHASE=...`)
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/server"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		mode := fs.String("mode", "all", "all|api|gateway|bid-engine|timer|pg-writer")
		_ = fs.Parse(os.Args[2:])
		if err := server.Serve(ctx, mustConfig(), *mode); err != nil {
			log.Fatalf("serve: %v", err)
		}

	case "seed":
		if err := server.Seed(ctx, mustConfig()); err != nil {
			log.Fatalf("seed: %v", err)
		}

	case "verify":
		fs := flag.NewFlagSet("verify", flag.ExitOnError)
		aid := fs.String("auction", os.Getenv("VERIFY_AID"), "auction id (default auc_demo)")
		_ = fs.Parse(os.Args[2:])
		if err := server.RunVerify(ctx, mustConfig(), *aid); err != nil {
			log.Fatalf("verify: %v", err)
		}

	case "verify-evidence":
		fs := flag.NewFlagSet("verify-evidence", flag.ExitOnError)
		aid := fs.String("auction", os.Getenv("VERIFY_AID"), "auction id (default auc_demo)")
		_ = fs.Parse(os.Args[2:])
		if err := server.RunVerifyEvidence(ctx, mustConfig(), *aid); err != nil {
			log.Fatalf("verify-evidence: %v", err)
		}

	case "e2e":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunE2E(target); err != nil {
			log.Fatalf("e2e: %v", err)
		}

	case "demo-auction":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemo(target); err != nil {
			log.Fatalf("demo-auction: %v", err)
		}

	case "demo-sudden-death":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoSuddenDeath(target); err != nil {
			log.Fatalf("demo-sudden-death: %v", err)
		}

	case "demo-sealed":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoSealed(target); err != nil {
			log.Fatalf("demo-sealed: %v", err)
		}

	case "demo-vickrey":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoVickrey(target); err != nil {
			log.Fatalf("demo-vickrey: %v", err)
		}

	case "demo-hybrid":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoHybrid(target); err != nil {
			log.Fatalf("demo-hybrid: %v", err)
		}

	case "demo-allpay":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoAllPay(target); err != nil {
			log.Fatalf("demo-allpay: %v", err)
		}

	case "demo-prequalify":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunDemoPrequalify(target); err != nil {
			log.Fatalf("demo-prequalify: %v", err)
		}

	case "perf-smoke":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunPerfSmoke(target); err != nil {
			log.Fatalf("perf-smoke: %v", err)
		}

	case "load":
		target := os.Getenv("TARGET")
		if target == "" {
			target = "http://localhost:8080"
		}
		if err := server.RunLoad(target); err != nil {
			log.Fatalf("load: %v", err)
		}

	case "chaos":
		fs := flag.NewFlagSet("chaos", flag.ExitOnError)
		target := fs.String("target", envOr("TARGET", "http://localhost:8080"), "stack base URL")
		phase := fs.String("phase", "", "setup|bid-expect|connect-fails|state-expect|catchup-expect|wait-events")
		aid := fs.String("aid", "", "auction id (for non-setup phases)")
		token := fs.String("token", "", "buyer JWT (skips devLogin so MySQL-down drills keep working)")
		code := fs.String("code", "", "expected BID_PLACE wire code (bid-expect)")
		state := fs.String("state", "", "expected auction state (state-expect)")
		lastSeq := fs.Int64("last-seq", 0, "ROOM_JOIN.lastSeq (catchup-expect)")
		wantSeq := fs.Int64("want-seq", 0, "minimum seq / events-count threshold")
		durationMs := fs.Int64("duration-ms", 0, "auction duration for setup phase (default 600000 = 10min)")
		timeoutMs := fs.Int64("timeout-ms", 10000, "per-phase wall-clock budget")
		_ = fs.Parse(os.Args[2:])
		if *phase == "" {
			log.Fatalf("chaos: --phase required")
		}
		if err := server.RunChaos(server.ChaosOptions{
			Target:     *target,
			Phase:      *phase,
			AID:        *aid,
			Token:      *token,
			Code:       *code,
			State:      *state,
			LastSeq:    *lastSeq,
			WantSeq:    *wantSeq,
			DurationMs: *durationMs,
			Timeout:    time.Duration(*timeoutMs) * time.Millisecond,
		}); err != nil {
			fmt.Printf("CHAOS_FAIL phase=%s err=%v\n", *phase, err)
			log.Fatalf("chaos: %v", err)
		}

	default:
		usage()
		os.Exit(2)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustConfig() config.Config {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	return cfg
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lumen <serve|seed|verify|verify-evidence|e2e|demo-auction|perf-smoke|load|chaos> [flags]")
}
