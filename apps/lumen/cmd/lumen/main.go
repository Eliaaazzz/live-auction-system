// Command lumen is the single Lumen Auction backend binary, subcommand-dispatched:
//
//	lumen serve --mode=all|api|gateway|bid-engine|timer|pg-writer
//	lumen seed
//	lumen verify [--auction <id>]            (T6 unified: 3-way diff + hash chain; exit!=0 on mismatch or break)
//	lumen verify-evidence [--auction <id>]   (T4 hash-chain only; same chain check, no 3-way diff)
//	lumen e2e            (drives TARGET, default http://localhost:8080)
//	lumen perf-smoke     (drives TARGET; ack/broadcast p95 floor-check)
//	lumen load           (drives TARGET; T8 P0 gate — 500 connected + 50 active, asserts §4.2 budgets)
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

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

	default:
		usage()
		os.Exit(2)
	}
}

func mustConfig() config.Config {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	return cfg
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lumen <serve|seed|verify|verify-evidence|e2e|perf-smoke|load> [flags]")
}
