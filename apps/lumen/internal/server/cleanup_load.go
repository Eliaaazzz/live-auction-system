package server

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

type CleanupLoadOptions struct {
	AuctionIDs       []string
	AuctionFile      string
	ScanLoadAuctions bool
	DryRun           bool
}

// RunCleanupLoad removes ephemeral Redis state for load-style auctions so local
// staging/CI can recover from stale auction state between load runs.
func RunCleanupLoad(ctx context.Context, cfg config.Config, opts CleanupLoadOptions) error {
	st, err := store.New(ctx, cfg.RedisAddr, cfg.MySQLDSN, cfg.RedisPassword, cfg.EvidenceHMACKey, cfg.RedisUseTLS)
	if err != nil {
		return fmt.Errorf("store.new: %w", err)
	}
	defer st.Close()

	ids := make([]string, 0, len(opts.AuctionIDs))
	seen := make(map[string]struct{}, len(opts.AuctionIDs)*2)
	for _, id := range opts.AuctionIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}

	if opts.AuctionFile != "" {
		extra, err := loadAuctionIDsFromFile(opts.AuctionFile)
		if err != nil {
			return fmt.Errorf("read auction file: %w", err)
		}
		for _, id := range extra {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
	}

	if opts.ScanLoadAuctions {
		stateAIDs, err := st.ScanStateAIDs(ctx)
		if err != nil {
			return fmt.Errorf("scan state auction ids: %w", err)
		}
		for _, aid := range stateAIDs {
			match, err := isLikelyLoadAuction(ctx, st, aid)
			if err != nil {
				return fmt.Errorf("inspect auction %s: %w", aid, err)
			}
			if match {
				if _, ok := seen[aid]; !ok {
					seen[aid] = struct{}{}
					ids = append(ids, aid)
				}
			}
		}
	}

	if len(ids) == 0 {
		return fmt.Errorf("no auctions resolved; pass --auction, --auction-file, or --scan-load-auctions")
	}

	for _, id := range ids {
		if opts.DryRun {
			fmt.Printf("cleanup-load: dry-run would reset auction=%s\n", id)
			continue
		}
		if err := st.ResetAuctionRedisState(ctx, id); err != nil {
			return fmt.Errorf("cleanup auction %s: %w", id, err)
		}
		fmt.Printf("cleanup-load: reset auction=%s\n", id)
	}
	return nil
}

func loadAuctionIDsFromFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	seen := make(map[string]struct{})
	out := make([]string, 0)
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" {
			continue
		}
		for _, part := range strings.Split(line, ",") {
			p := strings.TrimSpace(part)
			if p == "" {
				continue
			}
			if _, ok := seen[p]; !ok {
				seen[p] = struct{}{}
				out = append(out, p)
			}
		}
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func isLikelyLoadAuction(ctx context.Context, st *store.Store, aid string) (bool, error) {
	stateK := fmt.Sprintf("auction:{%s}:state", aid)
	m, err := st.Redis().HGetAll(ctx, stateK).Result()
	if err != nil {
		return false, err
	}
	if m == nil || len(m) == 0 {
		return false, nil
	}

	ruleStart := parseRedisInt64(m["startPriceCents"])
	ruleInc := parseRedisInt64(m["incrementCents"])
	ruleCap := parseRedisInt64(m["capPriceCents"])
	ruleExtendWindow := parseRedisInt64(m["extendWindowSec"])
	ruleExtend := parseRedisInt64(m["extendSec"])

	if ruleStart != loadStartCents {
		return false, nil
	}
	if ruleInc != 1 {
		return false, nil
	}
	if ruleCap != 0 {
		return false, nil
	}
	if ruleExtendWindow != 0 {
		return false, nil
	}
	if ruleExtend != 0 {
		return false, nil
	}

	return true, nil
}

func parseRedisInt64(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
