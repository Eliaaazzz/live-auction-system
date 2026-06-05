package server

import (
	"context"
	"fmt"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

type CleanupLoadArtifactsOptions struct {
	Prefix  string
	Execute bool
}

func RunCleanupLoadArtifacts(ctx context.Context, cfg config.Config, opts CleanupLoadArtifactsOptions) error {
	st, err := store.NewWithRedisPassword(ctx, cfg.RedisAddr, cfg.RedisPassword, cfg.MySQLDSN, cfg.EvidenceHMACKey)
	if err != nil {
		return err
	}
	defer st.Close()

	res, err := st.CleanupLoadArtifacts(ctx, opts.Prefix, opts.Execute)
	if err != nil {
		return err
	}
	mode := "dry-run"
	if opts.Execute {
		mode = "execute"
	}
	fmt.Printf("cleanup-load-auctions mode=%s prefix=%s\n", mode, res.Prefix)
	fmt.Printf("matched_auctions=%d matched_keys=%d\n", len(res.AuctionIDs), len(res.Keys))
	for _, aid := range res.AuctionIDs {
		fmt.Printf("auction=%s\n", aid)
	}
	for _, key := range res.Keys {
		fmt.Printf("key=%s\n", key)
	}
	if opts.Execute {
		fmt.Printf("deleted_keys=%d untracked_active=%d\n", res.DeletedKeys, res.Untracked)
	} else {
		fmt.Println("dry_run=true; set --execute or LOAD_CLEANUP_EXECUTE=1 to delete matched Redis load artifacts")
	}
	fmt.Println("mysql_rows_deleted=0 evidence_rows_deleted=0")
	return nil
}
