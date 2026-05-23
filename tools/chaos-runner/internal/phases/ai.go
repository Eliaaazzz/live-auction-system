// ai.go — AI sidecar process-kill drill.
//
// V9 §4.4 phase 5 (AI offline). Per RFC v2 §0 + diagram #7 (PR #21):
// AI is non-authoritative; killing the sidecar MUST NOT affect bid
// acceptance. This drill records that claim as evidence.
//
// Why this is the safest first implementation:
//  1. The fault target (ai-sidecar container) is isolated from the bid
//     hot path — even a buggy Inject can't break the auction loop.
//  2. The expected invariants are unambiguous: bid acceptance rate
//     unchanged, AI badge flips offline, sidecar restart restores
//     auctioneer trigger.
//  3. Restoration is a simple docker compose restart — no exotic
//     state to roll back.
package phases

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
)

const aiContainerName = "ai-sidecar" // canonical service name in infra/docker-compose.yml

type aiPhase struct{}

func (aiPhase) Name() string { return "ai" }
func (aiPhase) Kind() string { return "process_kill" }

func (aiPhase) ExpectedDegradeWireCodes() []string {
	// AI down does NOT degrade bidding — bid acceptance must continue with
	// OK_ACCEPTED. The `degrade` invariant is skipped when this is empty.
	// (What *does* degrade: facts/draft + auctioneer/trigger return 503,
	// but those are out of the WS bid path.)
	return nil
}

func (aiPhase) RecoveryDeadline() string { return "30s" }

func (aiPhase) Inject(ctx context.Context, env Env) (func(context.Context) error, error) {
	project := env.ComposeProject
	if project == "" {
		project = "infra"
	}
	slog.InfoContext(ctx, "chaos.ai.inject", "container", aiContainerName, "action", "kill -SIGTERM")
	if err := composeKill(ctx, project, aiContainerName, "SIGTERM"); err != nil {
		return func(context.Context) error { return nil }, fmt.Errorf("inject: %w", err)
	}
	uninject := func(ctx context.Context) error {
		slog.InfoContext(ctx, "chaos.ai.uninject", "container", aiContainerName, "action", "compose start")
		// `compose start <svc>` restarts a stopped container in-place,
		// preserving the docker-compose volumes/network. `compose up -d
		// <svc>` would rebuild if Dockerfile changed; we don't want that.
		return composeStart(ctx, project, aiContainerName)
	}
	return uninject, nil
}

// composeKill sends a signal to a service via `docker compose kill -s <sig>`.
// We use SIGTERM not SIGKILL so the sidecar can log its own shutdown — that
// log line is part of the artifact ("did we go down cleanly?").
func composeKill(ctx context.Context, project, service, signal string) error {
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", "infra/docker-compose.yml",
		"-p", project,
		"kill", "-s", signal, service,
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose kill %s: %w (output: %s)", service, err, out.String())
	}
	return nil
}

func composeStart(ctx context.Context, project, service string) error {
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", "infra/docker-compose.yml",
		"-p", project,
		"start", service,
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose start %s: %w (output: %s)", service, err, out.String())
	}
	return nil
}
