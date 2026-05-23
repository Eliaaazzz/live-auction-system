// chaos-runner — orchestrates a single chaos drill against a running Lumen stack
// and emits a machine-readable artifact for evidence.
//
// Per docs/components/14-chaos.md + V9 §4.4 (5 fault drills demo-required) +
// PR #21 diagram #8 ("Delivery Ownership and Evidence Map v4") which places
// chaos-runner under the "five fault videos" evidence column.
//
// Usage:
//
//	chaos-runner --phase <ai|redis|mysql|ws|timer|slowclient|schrodinger|tamper> \
//	             --duration 5s \
//	             --target-aid auc_demo \
//	             --out docs/demo/chaos-recordings/
//
// The runner is *intentionally* not bundled with `lumen serve` — it's a
// separate process so it can be killed independently and so its own failure
// can never affect the auction hot path.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/orchestrator"
	"github.com/Eliaaazzz/live-auction-system/tools/chaos-runner/internal/phases"
)

func main() {
	var (
		phaseName  = flag.String("phase", "", "fault to inject: ai | redis | mysql | ws | timer | slowclient | schrodinger | tamper")
		duration   = flag.Duration("duration", 5*time.Second, "how long to hold the fault before uninject")
		recoverFor = flag.Duration("recover", 30*time.Second, "how long to observe recovery after uninject")
		targetAID  = flag.String("target-aid", "auc_demo", "auction id used by the steady-bid generator")
		bidRate    = flag.Int("bid-rate", 5, "steady-bid generator rate (bids/sec) during drill")
		outDir     = flag.String("out", "docs/demo/chaos-recordings", "artifact output directory")
		composeURL = flag.String("compose-base", "http://localhost:8080", "lumen base URL (T1 single-binary topology)")
		toxiURL    = flag.String("toxiproxy", "http://localhost:8474", "toxiproxy admin API (network-level faults)")
	)
	flag.Parse()

	if *phaseName == "" {
		fmt.Fprintln(os.Stderr, "missing --phase; see --help")
		os.Exit(2)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	phase, err := phases.Lookup(*phaseName)
	if err != nil {
		// NotImplemented is treated as a known/expected failure mode: exit 78
		// so CI can distinguish "phase isn't built yet" from "phase ran but
		// invariants failed" (exit 1) and "tooling broke" (exit 3).
		if errors.Is(err, phases.ErrNotImplemented) {
			slog.Error("phase recognized but not yet implemented in this skeleton",
				"phase", *phaseName,
				"see", "tools/chaos-runner/README.md § phase taxonomy")
			os.Exit(78)
		}
		slog.Error("unknown phase", "phase", *phaseName, "err", err)
		os.Exit(2)
	}

	cfg := orchestrator.Config{
		Phase:        phase,
		Duration:     *duration,
		RecoverFor:   *recoverFor,
		TargetAID:    *targetAID,
		BidRate:      *bidRate,
		ArtifactDir:  *outDir,
		LumenBaseURL: *composeURL,
		ToxiproxyURL: *toxiURL,
	}
	result, err := orchestrator.Run(ctx, cfg)
	if err != nil {
		slog.Error("orchestrator error", "err", err)
		os.Exit(3)
	}

	fmt.Printf("artifact: %s\n", result.ArtifactPath)
	if !result.AllInvariantsPassed {
		fmt.Fprintln(os.Stderr, "FAIL: one or more invariants did not pass")
		os.Exit(1)
	}
	fmt.Println("PASS: chaos drill complete; all invariants held")
}
