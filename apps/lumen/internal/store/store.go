// Package store owns the Redis (hot path + Lua) and MySQL (fact store)
// connections. Lua scripts are the only writers of hot keys; Go calls them via
// EVALSHA. See proto/redis-keys.md and proto/db-schema.md.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/lua"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

type Store struct {
	rdb                *redis.Client
	db                 *sql.DB
	shaPlaceBid        string
	shaPlaceBidSealed  string // sealed modes (issue #114)
	shaPlaceBidHybrid  string // hybrid-reveal mode (issue #114)
	shaFreeze          string
	shaStart           string
	shaClose           string
	shaCloseSealed     string // sealed reveal + hammer (issue #114)
	shaCloseAllPay     string // ALL_PAY reveal + winner/runner-up coin settlement (issue #114)
	shaCancel          string
	evidenceKeySource  EvidenceKeySource
	evidenceKeyVersion int
	evidenceKey        []byte // active HMAC key for the auction_events hash chain (T4)
}

const redisUnavailableTimeout = time.Second

// New connects to Redis + MySQL and loads the Lua scripts. Connections are
// retried (up to ~30s) so startup is robust against datastores still booting
// (e.g. MySQL finishing first-run init after its healthcheck flips healthy).
// evidenceKey is the HMAC key for the auction_events hash chain (T4); the writer
// (persistence worker) and any verifier must use the same key, so it is threaded
// in at construction rather than set later.
func New(ctx context.Context, redisAddr, mysqlDSN, evidenceKey string) (*Store, error) {
	return NewWithRedisPassword(ctx, redisAddr, "", mysqlDSN, evidenceKey)
}

func NewWithRedisPassword(ctx context.Context, redisAddr, redisPassword, mysqlDSN, evidenceKey string) (*Store, error) {
	return NewWithRedisPasswordAndEvidenceKeySource(ctx, redisAddr, redisPassword, mysqlDSN, NewStaticEvidenceKeySource(evidenceKey))
}

// NewWithEvidenceKeySource is the rotation-ready constructor: production still
// passes an env-backed static source through New, while a future KMS/key-ring
// source can implement EvidenceKeySource without changing Store callers again.
func NewWithEvidenceKeySource(ctx context.Context, redisAddr, mysqlDSN string, evidenceKeys EvidenceKeySource) (*Store, error) {
	return NewWithRedisPasswordAndEvidenceKeySource(ctx, redisAddr, "", mysqlDSN, evidenceKeys)
}

func NewWithRedisPasswordAndEvidenceKeySource(ctx context.Context, redisAddr, redisPassword, mysqlDSN string, evidenceKeys EvidenceKeySource) (*Store, error) {
	if evidenceKeys == nil {
		return nil, errors.New("evidence key source is nil")
	}
	evidenceKeyVersion, evidenceKey, err := evidenceKeys.CurrentEvidenceKey()
	if err != nil {
		return nil, fmt.Errorf("evidence key source: %w", err)
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:                  redisAddr,
		Password:              redisPassword,
		MaxRetries:            -1,
		DialTimeout:           redisUnavailableTimeout,
		ReadTimeout:           redisUnavailableTimeout,
		WriteTimeout:          redisUnavailableTimeout,
		PoolTimeout:           redisUnavailableTimeout,
		ContextTimeoutEnabled: true,
	})
	if err := pingWithRetry(ctx, "redis", func(c context.Context) error { return rdb.Ping(c).Err() }); err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", mysqlDSN)
	if err != nil {
		return nil, fmt.Errorf("mysql open: %w", err)
	}
	db.SetMaxOpenConns(32)
	db.SetMaxIdleConns(16)
	db.SetConnMaxLifetime(2 * time.Minute)
	if err := pingWithRetry(ctx, "mysql", db.PingContext); err != nil {
		return nil, err
	}
	s := &Store{rdb: rdb, db: db, evidenceKeySource: evidenceKeys, evidenceKeyVersion: evidenceKeyVersion, evidenceKey: evidenceKey}
	if err := s.loadScripts(ctx); err != nil {
		return nil, err
	}
	if err := s.migrate(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// migrate applies idempotent schema migrations that the first-init DDL
// (infra/mysql/init) does NOT cover on a pre-existing volume — docker init SQL
// runs only on a fresh volume, but `make up` keeps volumes. MySQL 8 has no
// ADD COLUMN IF NOT EXISTS, so each migration checks information_schema first.
func (s *Store) migrate(ctx context.Context) error {
	if err := s.ensureColumn(ctx, "auction_rules", "max_extensions", "BIGINT NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	// Auction mode (issue #114). Existing rows default to ENGLISH so pre-mode
	// auctions keep behaving exactly as before.
	if err := s.ensureColumn(ctx, "auction_rules", "mode", "VARCHAR(32) NOT NULL DEFAULT 'ENGLISH'"); err != nil {
		return err
	}
	// Pre-qualifying link (issue #114 phase 6): a formal auction can carry the
	// id of the sealed PREQUALIFY parent it was seeded from. Nullable; standalone
	// auctions leave it NULL.
	if err := s.ensureColumn(ctx, "auctions", "parent_auction_id", "VARCHAR(64) NULL DEFAULT NULL"); err != nil {
		return err
	}
	if err := s.ensureIndex(ctx, "auctions", "idx_auctions_parent", "(parent_auction_id)"); err != nil {
		return err
	}
	// coin_ledger (issue #114 ALL_PAY): see init SQL for the canonical schema.
	// CREATE TABLE IF NOT EXISTS is idempotent — safe on existing volumes.
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS coin_ledger (
		id          BIGINT AUTO_INCREMENT PRIMARY KEY,
		auction_id  VARCHAR(64) NOT NULL,
		user_id     VARCHAR(64) NOT NULL,
		delta_coins BIGINT NOT NULL,
		reason      VARCHAR(32) NOT NULL,
		seq         BIGINT NOT NULL,
		created_at  DATETIME NOT NULL,
		UNIQUE KEY uq_coin (auction_id, user_id, seq),
		KEY ix_coin_auction (auction_id)
	)`); err != nil {
		return fmt.Errorf("create coin_ledger: %w", err)
	}
	if err := s.ensureColumn(ctx, "auction_events", "updated_at", "DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auction_events", "hmac_key_version", "SMALLINT NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	if err := s.ensureIndex(ctx, "auction_events", "idx_events_auction_updated", "(auction_id, updated_at)"); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS evidence_chain_cache (
		auction_id           VARCHAR(64) PRIMARY KEY,
		verified_seq         BIGINT       NOT NULL,
		events_count         BIGINT       NOT NULL,
		chain_head           VARCHAR(128) NOT NULL,
		max_event_updated_at DATETIME(6)  NOT NULL,
		verified_at          DATETIME(6)  NOT NULL
	)`); err != nil {
		return fmt.Errorf("create evidence_chain_cache: %w", err)
	}
	// #121: optional 火山直播 play URL. Display-only (non-authoritative), off the hot path.
	if err := s.ensureColumn(ctx, "auction_rules", "live_play_url", "VARCHAR(512) NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	// #121 SRS primary path: per-auction stream key for seller/admin push material.
	if err := s.ensureColumn(ctx, "auction_rules", "live_stream_key", "VARCHAR(128) NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	return nil
}

// ensureColumn adds table.column with the given DDL if it is absent. table,
// column and ddl are trusted constants (never user input), so the formatted
// ALTER is safe.
func (s *Store) ensureColumn(ctx context.Context, table, column, ddl string) error {
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM information_schema.columns
		 WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
		table, column).Scan(&n); err != nil {
		return fmt.Errorf("check column %s.%s: %w", table, column, err)
	}
	if n > 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, ddl)); err != nil {
		return fmt.Errorf("add column %s.%s: %w", table, column, err)
	}
	return nil
}

// ensureIndex creates an index when it is absent. table, indexName, and columns are
// trusted constants from migrate(), never user input.
func (s *Store) ensureIndex(ctx context.Context, table, indexName, columns string) error {
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM information_schema.statistics
		 WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
		table, indexName).Scan(&n); err != nil {
		return fmt.Errorf("check index %s.%s: %w", table, indexName, err)
	}
	if n > 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("CREATE INDEX %s ON %s %s", indexName, table, columns)); err != nil {
		return fmt.Errorf("create index %s.%s: %w", table, indexName, err)
	}
	return nil
}

func pingWithRetry(ctx context.Context, name string, ping func(context.Context) error) error {
	var err error
	for i := 0; i < 30; i++ {
		if err = ping(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("%s not ready after retries: %w", name, err)
}

func (s *Store) loadScripts(ctx context.Context) error {
	var err error
	if s.shaPlaceBid, err = s.rdb.ScriptLoad(ctx, lua.PlaceBid).Result(); err != nil {
		return fmt.Errorf("load place_bid.lua: %w", err)
	}
	if s.shaPlaceBidSealed, err = s.rdb.ScriptLoad(ctx, lua.PlaceBidSealed).Result(); err != nil {
		return fmt.Errorf("load place_bid_sealed.lua: %w", err)
	}
	if s.shaPlaceBidHybrid, err = s.rdb.ScriptLoad(ctx, lua.PlaceBidHybrid).Result(); err != nil {
		return fmt.Errorf("load place_bid_hybrid.lua: %w", err)
	}
	if s.shaCloseSealed, err = s.rdb.ScriptLoad(ctx, lua.CloseSealed).Result(); err != nil {
		return fmt.Errorf("load close_auction_sealed.lua: %w", err)
	}
	if s.shaCloseAllPay, err = s.rdb.ScriptLoad(ctx, lua.CloseAllPay).Result(); err != nil {
		return fmt.Errorf("load close_auction_allpay.lua: %w", err)
	}
	if s.shaFreeze, err = s.rdb.ScriptLoad(ctx, lua.FreezeRules).Result(); err != nil {
		return fmt.Errorf("load freeze_rules.lua: %w", err)
	}
	if s.shaStart, err = s.rdb.ScriptLoad(ctx, lua.StartAuction).Result(); err != nil {
		return fmt.Errorf("load start_auction.lua: %w", err)
	}
	if s.shaClose, err = s.rdb.ScriptLoad(ctx, lua.CloseAuction).Result(); err != nil {
		return fmt.Errorf("load close_auction.lua: %w", err)
	}
	if s.shaCancel, err = s.rdb.ScriptLoad(ctx, lua.CancelAuction).Result(); err != nil {
		return fmt.Errorf("load cancel_auction.lua: %w", err)
	}
	return nil
}

func (s *Store) Redis() *redis.Client { return s.rdb }
func (s *Store) DB() *sql.DB          { return s.db }

func (s *Store) Close() error {
	_ = s.rdb.Close()
	return s.db.Close()
}

// --- key helpers (cluster hash tag {<aid>} keeps multi-key Lua in one slot) ---

func stateKey(aid string) string       { return fmt.Sprintf("auction:{%s}:state", aid) }
func lbKey(aid string) string          { return fmt.Sprintf("auction:{%s}:leaderboard", aid) }
func streamKey(aid string) string      { return fmt.Sprintf("auction:{%s}:events", aid) }
func dedupeKey(aid, uid string) string { return fmt.Sprintf("auction:{%s}:dedupe:%s", aid, uid) }

// Private sealed-mode keys (issue #114): never read by Snapshot/Leaderboard
// during LIVE, so bid amounts stay hidden until the reveal at close.
func sealedKey(aid string) string      { return fmt.Sprintf("auction:{%s}:sealed", aid) }
func sealedNamesKey(aid string) string { return fmt.Sprintf("auction:{%s}:sealednames", aid) }

// HasDedupe reports whether a clientBidID already has a cached BID_ACCEPTED
// payload in the per-(auction,user) dedupe Hash. Used by the V10k Tier C
// gateway-side fast-reject path to preserve DUPLICATE-replay semantics — if
// a retry hits the gateway with a previously-accepted clientBidId, we must
// fall through to Lua (which returns DUPLICATE with the original ack) rather
// than fast-rejecting as ERR_TOO_LOW (which violates proto/error-codes.md
// "DUPLICATE replays cached ack and is not an error").
//
// One HEXISTS RTT (~50μs localhost, ~1ms cross-host) — still much cheaper
// than the full EVALSHA the fast-path is replacing. Errors fall through to
// the caller (which treats them as "unsure → defer to Lua").
func (s *Store) HasDedupe(ctx context.Context, aid, userID, clientBidID string) (bool, error) {
	return s.rdb.HExists(ctx, dedupeKey(aid, userID), clientBidID).Result()
}

// FastPathState carries every gateway-side fact the V10k Tier C fast-reject
// needs to mirror Lua's check ordering exactly. Loaded in ONE pipelined Redis
// RTT by FastPathPrecheck. The caller fast-rejects ONLY when ALL of:
//   - isLive (status=="LIVE")
//   - !isPaused
//   - !isSellerSelfBid
//   - !isDupe
//
// hold simultaneously. Any single negative falls through to Lua so the
// authoritative error code (ERR_AUCTION_PAUSED / ERR_NOT_LIVE / ERR_NOT_ALLOWED
// / DUPLICATE-replay) is returned instead of a mistaken ERR_TOO_LOW.
type FastPathState struct {
	IsLive          bool // state.status == "LIVE"
	IsPaused        bool // state.paused == "true" (Redis-down or operator pause)
	IsSellerSelfBid bool // state.sellerId == userID (anti-shill-bidding)
	IsDupe          bool // dedupe Hash has clientBidID for (aid,userID)
}

// FastPathPrecheck is the V10k Tier C fast-reject's authoritative state probe.
// Returns a FastPathState reflecting Lua's view of `state:{<aid>}` + the
// per-user dedupe Hash in ONE pipelined Redis round-trip.
//
// Mirrors place_bid.lua's check order:
//  1. dedupe (step 1) → isDupe
//  2. paused (step 2)  → isPaused
//  3. status (step 2)  → !isLive when status != "LIVE"
//  4. seller-self-bid (step 2) → isSellerSelfBid
//
// place_bid.lua step 3 (now >= endAtMs) is covered by the gateway-side
// fastRejectExpiryMarginMs guard in dispatchWS — checking Redis TIME again here
// would add another HGET; the margin avoids the round-trip without breaking
// correctness under bounded clock skew.
//
// Cost: ONE pipelined Pipeline.Exec → single network RTT (~100μs localhost,
// ~1ms cross-host). Still much cheaper than the full EVALSHA hot path (~6ms)
// being skipped, so the throughput win is preserved.
//
// Errors fall through to Lua (caller treats as "unsure → defer to authoritative
// source"; a Redis-down condition then surfaces on the Lua path as
// ERR_AUCTION_PAUSED via bidErrCode, matching today's semantics).
func (s *Store) FastPathPrecheck(ctx context.Context, aid, userID, clientBidID string) (FastPathState, error) {
	pipe := s.rdb.Pipeline()
	stateCmd := pipe.HMGet(ctx, stateKey(aid), "status", "paused", "sellerId")
	dupeCmd := pipe.HExists(ctx, dedupeKey(aid, userID), clientBidID)
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return FastPathState{}, err
	}
	out := FastPathState{}
	if fields, herr := stateCmd.Result(); herr == nil && len(fields) >= 3 {
		if status, ok := fields[0].(string); ok {
			out.IsLive = status == "LIVE"
		}
		if paused, ok := fields[1].(string); ok {
			out.IsPaused = paused == "true"
		}
		if sellerID, ok := fields[2].(string); ok && sellerID != "" {
			out.IsSellerSelfBid = sellerID == userID
		}
	}
	dupe, derr := dupeCmd.Result()
	if derr != nil && derr != redis.Nil {
		return out, derr
	}
	out.IsDupe = dupe
	return out, nil
}

// PubChannel is the per-auction Pub/Sub fanout hint channel.
func PubChannel(aid string) string { return fmt.Sprintf("auction:{%s}:pub", aid) }

// PubPattern matches all well-formed auction pub channels (gateway + persistence subscribe).
const PubPattern = "auction:{*}:pub"

// AIDFromPubChannel extracts <aid> from "auction:{<aid>}:pub".
func AIDFromPubChannel(ch string) string {
	const prefix, suffix = "auction:{", "}:pub"
	if !strings.HasPrefix(ch, prefix) || !strings.HasSuffix(ch, suffix) || len(ch) <= len(prefix)+len(suffix) {
		return ""
	}
	return ch[len(prefix) : len(ch)-len(suffix)]
}

func aidFromStreamKey(k string) string {
	const prefix, suffix = "auction:{", "}:events"
	if !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, suffix) || len(k) <= len(prefix)+len(suffix) {
		return ""
	}
	return k[len(prefix) : len(k)-len(suffix)]
}

// ScanEventStreamAIDs returns every auction id that has an events Stream, by
// SCANning the keyspace. The Persistence Worker uses this to sweep the canonical
// Stream independently of Pub/Sub hints (at-least-once projection: survives a
// worker that started after the publish, a dropped hint, or a process restart).
func (s *Store) ScanEventStreamAIDs(ctx context.Context) ([]string, error) {
	var aids []string
	var cursor uint64
	for {
		keys, cur, err := s.rdb.Scan(ctx, cursor, "auction:{*}:events", 200).Result()
		if err != nil {
			return nil, err
		}
		for _, k := range keys {
			if aid := aidFromStreamKey(k); aid != "" {
				aids = append(aids, aid)
			}
		}
		cursor = cur
		if cursor == 0 {
			return aids, nil
		}
	}
}

func aidFromStateKey(k string) string {
	const prefix, suffix = "auction:{", "}:state"
	if !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, suffix) || len(k) <= len(prefix)+len(suffix) {
		return ""
	}
	return k[len(prefix) : len(k)-len(suffix)]
}

func aidFromAuctionTaggedKey(k string) string {
	const prefix = "auction:{"
	if !strings.HasPrefix(k, prefix) {
		return ""
	}
	rest := k[len(prefix):]
	i := strings.IndexByte(rest, '}')
	if i <= 0 {
		return ""
	}
	return rest[:i]
}

// ScanStateAIDs returns every auction id that has a state Hash (frozen/live/terminal)
// by SCANning the keyspace. The Timer Worker uses this to reconcile the active index —
// re-tracking any LIVE auction missing from auction:active (e.g. a TrackActive that
// failed right after start_auction committed LIVE). Unlike ScanEventStreamAIDs this
// also finds a LIVE auction that has no bids yet (no events Stream), so the hammer is
// never silently lost.
func (s *Store) ScanStateAIDs(ctx context.Context) ([]string, error) {
	var aids []string
	var cursor uint64
	for {
		keys, cur, err := s.rdb.Scan(ctx, cursor, "auction:{*}:state", 200).Result()
		if err != nil {
			return nil, err
		}
		for _, k := range keys {
			if aid := aidFromStateKey(k); aid != "" {
				aids = append(aids, aid)
			}
		}
		cursor = cur
		if cursor == 0 {
			return aids, nil
		}
	}
}

type TimerErrInternalSuppression struct {
	UntilMs int64
	Reason  string
}

const (
	timerErrInternalSuppressUntilField = "timerErrInternalSuppressUntilMs"
	timerErrInternalReasonField        = "timerErrInternalReason"
	timerErrInternalAtField            = "timerErrInternalAtMs"
)

func (s *Store) MarkTimerErrInternalSuppression(ctx context.Context, aid, reason string, atMs, untilMs int64) error {
	if untilMs <= 0 {
		return s.rdb.HDel(ctx, stateKey(aid), timerErrInternalSuppressUntilField, timerErrInternalReasonField, timerErrInternalAtField).Err()
	}
	return s.rdb.HSet(ctx, stateKey(aid),
		timerErrInternalSuppressUntilField, strconv.FormatInt(untilMs, 10),
		timerErrInternalReasonField, reason,
		timerErrInternalAtField, strconv.FormatInt(atMs, 10),
	).Err()
}

func (s *Store) TimerErrInternalSuppression(ctx context.Context, aid string) (TimerErrInternalSuppression, error) {
	vals, err := s.rdb.HMGet(ctx, stateKey(aid), timerErrInternalSuppressUntilField, timerErrInternalReasonField).Result()
	if err != nil {
		return TimerErrInternalSuppression{}, err
	}
	var out TimerErrInternalSuppression
	if len(vals) > 0 {
		out.UntilMs = luaInt(vals[0])
	}
	if len(vals) > 1 {
		out.Reason, _ = vals[1].(string)
	}
	return out, nil
}

type CleanupLoadArtifactsResult struct {
	Prefix      string
	Execute     bool
	AuctionIDs  []string
	Keys        []string
	DeletedKeys int64
	Untracked   int64
}

func (s *Store) CleanupLoadArtifacts(ctx context.Context, prefix string, execute bool) (CleanupLoadArtifactsResult, error) {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = "auc_load_"
	}
	if !strings.HasPrefix(prefix, "auc_load_") {
		return CleanupLoadArtifactsResult{}, fmt.Errorf("cleanup prefix %q rejected: must start with auc_load_", prefix)
	}
	res := CleanupLoadArtifactsResult{Prefix: prefix, Execute: execute}
	seenAIDs := map[string]struct{}{}
	seenKeys := map[string]struct{}{}

	var cursor uint64
	pattern := fmt.Sprintf("auction:{%s*}:*", prefix)
	for {
		keys, cur, err := s.rdb.Scan(ctx, cursor, pattern, 200).Result()
		if err != nil {
			return res, err
		}
		for _, k := range keys {
			aid := aidFromAuctionTaggedKey(k)
			if !strings.HasPrefix(aid, prefix) {
				continue
			}
			seenAIDs[aid] = struct{}{}
			seenKeys[k] = struct{}{}
		}
		cursor = cur
		if cursor == 0 {
			break
		}
	}

	active, err := s.rdb.ZRange(ctx, activeKey, 0, -1).Result()
	if err != nil {
		return res, err
	}
	for _, aid := range active {
		if strings.HasPrefix(aid, prefix) {
			seenAIDs[aid] = struct{}{}
		}
	}

	res.AuctionIDs = make([]string, 0, len(seenAIDs))
	for aid := range seenAIDs {
		res.AuctionIDs = append(res.AuctionIDs, aid)
	}
	sort.Strings(res.AuctionIDs)
	res.Keys = make([]string, 0, len(seenKeys))
	for k := range seenKeys {
		res.Keys = append(res.Keys, k)
	}
	sort.Strings(res.Keys)

	if !execute {
		return res, nil
	}
	if len(res.Keys) > 0 {
		n, err := s.rdb.Del(ctx, res.Keys...).Result()
		if err != nil {
			return res, err
		}
		res.DeletedKeys = n
	}
	for _, aid := range res.AuctionIDs {
		n, err := s.rdb.ZRem(ctx, activeKey, aid).Result()
		if err != nil {
			return res, err
		}
		res.Untracked += n
	}
	return res, nil
}

// --- Lua dispatch ---

func (s *Store) eval(ctx context.Context, sha string, keys []string, args ...interface{}) ([]interface{}, error) {
	res, err := s.rdb.EvalSha(ctx, sha, keys, args...).Result()
	if err != nil {
		return nil, err
	}
	arr, ok := res.([]interface{})
	if !ok {
		return nil, fmt.Errorf("lua: unexpected result type %T", res)
	}
	if len(arr) == 0 {
		return nil, errors.New("lua: empty result")
	}
	return arr, nil
}

// FreezeRules runs freeze_rules.lua (DRAFT -> SCHEDULED). sellerID is copied into
// the state Hash so the hot path can reject seller self-bids. Returns the code.
func (s *Store) FreezeRules(ctx context.Context, aid, sellerID string, rules model.Rules) (string, error) {
	rj, _ := json.Marshal(rules)
	arr, err := s.eval(ctx, s.shaFreeze, []string{stateKey(aid)}, string(rj), sellerID)
	if err != nil {
		return "", err
	}
	return luaStr(arr[0]), nil
}

// StartAuction runs start_auction.lua (SCHEDULED -> LIVE). On OK_LIVE returns
// endAtMs and registers the auction in the Timer Worker's active index.
func (s *Store) StartAuction(ctx context.Context, aid string, durationMs int64) (string, int64, error) {
	arr, err := s.eval(ctx, s.shaStart, []string{stateKey(aid)}, durationMs)
	if err != nil {
		return "", 0, err
	}
	c := luaStr(arr[0])
	if c == model.CodeOKLive {
		endAtMs := luaInt(arr[1])
		// Best-effort registration in the Timer index. start_auction.lua already
		// committed LIVE atomically, so a ZADD failure here must NOT fail the start
		// (the seller would otherwise see a 500 for an auction that is actually live,
		// and a retry hits ERR_BAD_STATE — orphaning it from the hammer forever).
		// The Timer's reconcile re-tracks any LIVE auction missing from the index,
		// and close_auction re-checks Redis TIME regardless, so a missing/stale entry
		// only delays the hammer — never causes a wrong one.
		if err := s.TrackActive(ctx, aid, endAtMs); err != nil {
			log.Printf("StartAuction %s: track active failed (timer reconcile will recover): %v", aid, err)
		}
		return c, endAtMs, nil
	}
	return c, 0, nil
}

// activeKey is the global Timer Worker index (member=auctionId, score=endAtMs).
// It is NOT auction-tagged (one ZSET for all auctions), so the Lua hot-path
// scripts never touch it — the Go layer maintains it; close_auction re-checks
// Redis TIME so a stale score only costs a retry, never a premature hammer.
const activeKey = "auction:active"

// TrackActive registers/refreshes an auction in the Timer Worker index.
func (s *Store) TrackActive(ctx context.Context, aid string, endAtMs int64) error {
	return s.rdb.ZAdd(ctx, activeKey, redis.Z{Score: float64(endAtMs), Member: aid}).Err()
}

// UntrackActive removes an auction from the Timer Worker index (after close/cancel).
func (s *Store) UntrackActive(ctx context.Context, aid string) error {
	return s.rdb.ZRem(ctx, activeKey, aid).Err()
}

// DueAuctions returns auction ids whose endAtMs <= nowMs (hammer candidates).
func (s *Store) DueAuctions(ctx context.Context, nowMs int64) ([]string, error) {
	return s.rdb.ZRangeByScore(ctx, activeKey, &redis.ZRangeBy{
		Min: "-inf", Max: strconv.FormatInt(nowMs, 10),
	}).Result()
}

// RedisNowMs returns the authoritative Redis clock in milliseconds.
func (s *Store) RedisNowMs(ctx context.Context) (int64, error) {
	t, err := s.rdb.Time(ctx).Result()
	if err != nil {
		return 0, err
	}
	return t.UnixMilli(), nil
}

// CloseAuction runs the Timer hammer. For the sealed modes (issue #114) it
// dispatches to close_auction_sealed.lua, which reveals the sealed bids and
// picks the price (first-price vs Vickrey 2nd-price) at close; otherwise it runs
// the standard close_auction.lua. The mode is read from the state Hash (one HGET
// — the close path is the Timer's per-auction-once path, not the bid hot path).
// Returns the code and, on ERR_NOT_DUE, the current endAtMs so the caller can
// refresh the active score (anti-snipe may have moved it forward since the scan).
func (s *Store) CloseAuction(ctx context.Context, aid string) (string, int64, error) {
	code, _, endAtMs, err := s.CloseAuctionDetailed(ctx, aid)
	return code, endAtMs, err
}

func (s *Store) CloseAuctionDetailed(ctx context.Context, aid string) (string, string, int64, error) {
	// Read mode from the state Hash; a Redis error here MUST surface (so the
	// Timer retries) — silently defaulting to ENGLISH on a transient blip would
	// run the wrong close script on a sealed auction and lose the sealed bids
	// (PR #117 review). `redis.Nil` is the "no such field" case: a pre-mode
	// auction (frozen before issue #114) has no `mode` field — that's ENGLISH.
	modeRes := s.rdb.HGet(ctx, stateKey(aid), "mode")
	if rerr := modeRes.Err(); rerr != nil && !errors.Is(rerr, redis.Nil) {
		if redis.HasErrorPrefix(rerr, "WRONGTYPE") {
			return model.CodeErrInternal, "key_type", 0, nil
		}
		return "", "", 0, fmt.Errorf("close: read mode: %w", rerr)
	}
	mode := model.NormalizeMode(modeRes.Val())
	var arr []interface{}
	var err error
	switch mode {
	case model.ModeSealedFirst, model.ModeVickrey:
		priceMode := "FIRST"
		if mode == model.ModeVickrey {
			priceMode = "SECOND"
		}
		keys := []string{stateKey(aid), sealedKey(aid), sealedNamesKey(aid), lbKey(aid), streamKey(aid)}
		arr, err = s.eval(ctx, s.shaCloseSealed, keys, PubChannel(aid), priceMode)
	case model.ModeAllPay:
		keys := []string{stateKey(aid), sealedKey(aid), sealedNamesKey(aid), lbKey(aid), streamKey(aid)}
		arr, err = s.eval(ctx, s.shaCloseAllPay, keys, PubChannel(aid))
	default:
		arr, err = s.eval(ctx, s.shaClose, []string{stateKey(aid), streamKey(aid)}, PubChannel(aid))
	}
	if err != nil {
		return "", "", 0, err
	}
	c := luaStr(arr[0])
	if c == model.CodeErrNotDue && len(arr) >= 2 {
		return c, "", luaInt(arr[1]), nil
	}
	if c == model.CodeErrInternal && len(arr) >= 2 {
		return c, luaStr(arr[1]), 0, nil
	}
	return c, "", 0, nil
}

// CancelAuction runs cancel_auction.lua (seller/admin cancel of SCHEDULED/LIVE).
func (s *Store) CancelAuction(ctx context.Context, aid, callerID string) (string, error) {
	arr, err := s.eval(ctx, s.shaCancel, []string{stateKey(aid), streamKey(aid)}, callerID, PubChannel(aid))
	if err != nil {
		return "", err
	}
	return luaStr(arr[0]), nil
}

// PlaceBid runs place_bid.lua. Returns code, seq (on accept) and the JSON event
// payload (on OK_ACCEPTED / DUPLICATE).
func (s *Store) PlaceBid(ctx context.Context, aid, userID, clientBidID, amountCents, displayName string) (string, int64, string, error) {
	keys := []string{stateKey(aid), lbKey(aid), streamKey(aid), dedupeKey(aid, userID)}
	arr, err := s.eval(ctx, s.shaPlaceBid, keys, userID, clientBidID, amountCents, displayName, PubChannel(aid))
	if err != nil {
		return "", 0, "", err
	}
	switch c := luaStr(arr[0]); c {
	case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold:
		// All three accept the bid; the secondary AUCTION_EXTENDED/AUCTION_SOLD
		// event (arr[3..4]) is delivered to the room via Pub/Sub, so the gateway
		// only needs the bid ack (arr[1..2]) for the originating socket.
		if len(arr) < 3 {
			return "", 0, "", fmt.Errorf("lua: %s short result (len=%d)", c, len(arr))
		}
		return c, luaInt(arr[1]), luaStr(arr[2]), nil
	case model.CodeDuplicate:
		if len(arr) < 2 {
			return "", 0, "", fmt.Errorf("lua: DUPLICATE short result (len=%d)", len(arr))
		}
		return c, 0, luaStr(arr[1]), nil
	default:
		return c, 0, "", nil
	}
}

// PlaceBidHybrid runs place_bid_hybrid.lua (HYBRID_REVEAL, issue #114). Same
// shape as PlaceBid: returns the FULL bidder's ack (their own amount) as
// payload — the Stream broadcast carries the prior leader's amount + identity
// (the runner-up). On OK_EXTENDED / OK_SOLD the secondary event flows via
// Pub/Sub like English, so the gateway only needs the bid ack.
func (s *Store) PlaceBidHybrid(ctx context.Context, aid, userID, clientBidID, amountCents, displayName string) (string, int64, string, error) {
	keys := []string{stateKey(aid), lbKey(aid), streamKey(aid), dedupeKey(aid, userID)}
	arr, err := s.eval(ctx, s.shaPlaceBidHybrid, keys, userID, clientBidID, amountCents, displayName, PubChannel(aid))
	if err != nil {
		return "", 0, "", err
	}
	switch c := luaStr(arr[0]); c {
	case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold:
		if len(arr) < 3 {
			return "", 0, "", fmt.Errorf("lua: %s short result (len=%d)", c, len(arr))
		}
		return c, luaInt(arr[1]), luaStr(arr[2]), nil
	case model.CodeDuplicate:
		if len(arr) < 2 {
			return "", 0, "", fmt.Errorf("lua: DUPLICATE short result (len=%d)", len(arr))
		}
		return c, 0, luaStr(arr[1]), nil
	default:
		return c, 0, "", nil
	}
}

// PlaceBidSealed runs place_bid_sealed.lua (sealed modes, issue #114). The bid
// amount is recorded privately and NOT broadcast; the returned payload is the
// bidder's own PRIVATE ack (shaped like BID_ACCEPTED), pushed only to their
// socket. The room sees only the redacted SEALED_BID_RECEIVED stream event.
func (s *Store) PlaceBidSealed(ctx context.Context, aid, userID, clientBidID, amountCents, displayName string) (string, int64, string, error) {
	keys := []string{stateKey(aid), sealedKey(aid), sealedNamesKey(aid), streamKey(aid), dedupeKey(aid, userID)}
	arr, err := s.eval(ctx, s.shaPlaceBidSealed, keys, userID, clientBidID, amountCents, displayName, PubChannel(aid))
	if err != nil {
		return "", 0, "", err
	}
	switch c := luaStr(arr[0]); c {
	case model.CodeOKAccepted:
		if len(arr) < 3 {
			return "", 0, "", fmt.Errorf("lua: %s short result (len=%d)", c, len(arr))
		}
		return c, luaInt(arr[1]), luaStr(arr[2]), nil
	case model.CodeDuplicate:
		if len(arr) < 2 {
			return "", 0, "", fmt.Errorf("lua: DUPLICATE short result (len=%d)", len(arr))
		}
		return c, 0, luaStr(arr[1]), nil
	default:
		return c, 0, "", nil
	}
}

// LeaderEntry is one leaderboard row (highest accepted bid per user).
type LeaderEntry struct {
	UserID      string `json:"userId"`
	AmountCents string `json:"amountCents"`
}

// Leaderboard returns the top-n bidders by accepted max amount, descending.
// Money is a string at the boundary (proto/ws-envelope.md money-as-string).
//
// Mode-aware gating during LIVE (issue #114):
//   - SEALED_FIRST / VICKREY / ALL_PAY: returns empty — amounts are private
//     until AUCTION_REVEALED at close.
//   - HYBRID_REVEAL: filters out the current leader so the REST surface mirrors
//     the WS Stream (which broadcasts only the runner-up); without this gate
//     handleLeaderboard would expose the leader the WS broadcast hides.
//   - ENGLISH / SUDDEN_DEATH / terminal status: pass through unchanged.
//
// The ZSET itself stores all bids (the engine uses state.* fields for
// adjudication, not the ZSET, so we don't have to change the writer Lua).
func (s *Store) Leaderboard(ctx context.Context, aid string, n int) ([]LeaderEntry, error) {
	if n <= 0 {
		n = 10
	}
	z, err := s.rdb.ZRevRangeWithScores(ctx, lbKey(aid), 0, int64(n-1)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]LeaderEntry, 0, len(z))
	for _, m := range z {
		uid, _ := m.Member.(string)
		// scores are integer cents stored via ZADD; format without exponent/decimal.
		out = append(out, LeaderEntry{UserID: uid, AmountCents: strconv.FormatInt(int64(m.Score), 10)})
	}

	// Mode-aware gating. Read status/mode/winnerId in a single HMGET to keep
	// the cost flat; on any Redis error fall through to the unfiltered path
	// (defense-in-depth: never leak more than the current code would, never
	// less). HGET'ing fields not in the hash returns nil → empty strings; the
	// switch below treats unknown mode as ENGLISH (no gate), preserving back-
	// compat for pre-#114 auctions whose state hash has no `mode` field.
	state, herr := s.rdb.HMGet(ctx, stateKey(aid), "status", "mode", "winnerId").Result()
	if herr != nil || len(state) < 3 {
		return out, nil
	}
	status, _ := state[0].(string)
	modeRaw, _ := state[1].(string)
	winnerID, _ := state[2].(string)
	if status != model.StateLive {
		return out, nil
	}
	switch model.NormalizeMode(modeRaw) {
	case model.ModeSealedFirst, model.ModeVickrey, model.ModeAllPay:
		// Sealed family: hide everything during LIVE; reveal at close.
		return []LeaderEntry{}, nil
	case model.ModeHybridReveal:
		// Hide the current leader; runner-up + below stay visible to mirror
		// the broadcast surface (place_bid_hybrid.lua broadcasts the 2nd-place).
		filtered := out[:0]
		for _, e := range out {
			if e.UserID != winnerID {
				filtered = append(filtered, e)
			}
		}
		return filtered, nil
	}
	return out, nil
}

// Snapshot returns the current room state from the Redis state Hash.
func (s *Store) Snapshot(ctx context.Context, aid string) (model.RoomSnapshotData, error) {
	m, err := s.rdb.HGetAll(ctx, stateKey(aid)).Result()
	if err != nil {
		return model.RoomSnapshotData{}, err
	}
	return model.RoomSnapshotData{
		Status:            m["status"],
		CurrentPriceCents: m["currentPriceCents"],
		WinnerID:          m["winnerId"],
		EndAtMs:           parseInt(m["endAtMs"]),
		Seq:               parseInt(m["seq"]),
		Rules:             snapshotRules(m),
	}, nil
}

func snapshotRules(m map[string]string) *model.RoomSnapshotRules {
	if m["startPriceCents"] == "" && m["incrementCents"] == "" && m["capPriceCents"] == "" {
		return nil
	}
	var capCents *string
	if cap := moneyOrZero(m["capPriceCents"]); cap != "0" {
		capCents = &cap
	}
	return &model.RoomSnapshotRules{
		Mode:              model.NormalizeMode(m["mode"]),
		StepCents:         moneyOrZero(m["incrementCents"]),
		CapCents:          capCents,
		ReserveCents:      moneyOrZero(m["startPriceCents"]),
		MaxExtensions:     parseInt(m["maxExtensions"]),
		AntiSnipeWindowMs: parseInt(m["extendWindowSec"]) * 1000,
	}
}

func moneyOrZero(s string) string {
	if s == "" {
		return "0"
	}
	return s
}

// StreamEvent is one durable event read from the Redis Stream.
type StreamEvent struct {
	ID      string
	Seq     int64
	Type    string
	Payload string
}

// StreamLen returns XLEN of the auction's event Stream. T8 observability: the
// gateway sweeps this into a max gauge so the load report can show stream
// backlog growth (Persistence-lag proxy + AOF backlog signal). Stream missing
// is not an error: returns 0.
func (s *Store) StreamLen(ctx context.Context, aid string) (int64, error) {
	n, err := s.rdb.XLen(ctx, streamKey(aid)).Result()
	if err != nil {
		// XLEN on a missing key returns 0/nil; only surface non-nil errors so
		// the metrics sweep doesn't spam ENOENT-style noise during shutdown.
		return 0, err
	}
	return n, nil
}

// ReadEventsAfter returns Stream events after lastID (exclusive). lastID==""
// reads from the beginning.
func (s *Store) ReadEventsAfter(ctx context.Context, aid, lastID string) ([]StreamEvent, string, error) {
	start := streamRangeStart(lastID)
	lastSeq := streamIDSeq(lastID)
	msgs, err := s.rdb.XRange(ctx, streamKey(aid), start, "+").Result()
	if err != nil {
		return nil, lastID, err
	}
	out := make([]StreamEvent, 0, len(msgs))
	newLast := lastID
	for _, m := range msgs {
		seq := parseInt(valStr(m.Values, "seq"))
		if lastSeq > 0 && seq <= lastSeq {
			continue
		}
		out = append(out, StreamEvent{
			ID:      m.ID,
			Seq:     seq,
			Type:    valStr(m.Values, "type"),
			Payload: valStr(m.Values, "payload"),
		})
		newLast = m.ID
	}
	return out, newLast, nil
}

// LastAuctionReveal returns the sealed reveal event for a terminal sealed parent.
// The private sealed ZSET is scrubbed at close, so formal-auction recommendations
// must derive from the canonical Stream reveal event rather than private hot keys.
func (s *Store) LastAuctionReveal(ctx context.Context, aid string) (model.AuctionRevealedData, error) {
	msgs, err := s.rdb.XRevRangeN(ctx, streamKey(aid), "+", "-", 64).Result()
	if err != nil {
		return model.AuctionRevealedData{}, err
	}
	for _, m := range msgs {
		if valStr(m.Values, "type") != model.TypeAuctionRevealed {
			continue
		}
		var out model.AuctionRevealedData
		if err := json.Unmarshal([]byte(valStr(m.Values, "payload")), &out); err != nil {
			return model.AuctionRevealedData{}, fmt.Errorf("decode auction reveal: %w", err)
		}
		return out, nil
	}
	events, _, err := s.ReadEventsAfter(ctx, aid, "")
	if err != nil {
		return model.AuctionRevealedData{}, err
	}
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != model.TypeAuctionRevealed {
			continue
		}
		var out model.AuctionRevealedData
		if err := json.Unmarshal([]byte(events[i].Payload), &out); err != nil {
			return model.AuctionRevealedData{}, fmt.Errorf("decode auction reveal: %w", err)
		}
		return out, nil
	}
	return model.AuctionRevealedData{}, ErrNotFound
}

func streamRangeStart(lastID string) string {
	if lastID == "" {
		return "-"
	}
	lastID = strings.TrimPrefix(lastID, "(")
	if !strings.Contains(lastID, "-") {
		lastID += "-0"
	}
	return lastID
}

func streamIDSeq(id string) int64 {
	id = strings.TrimPrefix(id, "(")
	if i := strings.IndexByte(id, '-'); i >= 0 {
		id = id[:i]
	}
	return parseInt(id)
}

// --- small typed accessors for Lua/redis results ---

func luaStr(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	default:
		return ""
	}
}

func luaInt(v interface{}) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case string:
		return parseInt(x)
	default:
		return 0
	}
}

func valStr(m map[string]interface{}, k string) string { return luaStr(m[k]) }

func parseInt(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
