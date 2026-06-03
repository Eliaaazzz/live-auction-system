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
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/lua"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

type Store struct {
	rdb         *redis.Client
	db          *sql.DB
	shaPlaceBid string
	shaFreeze   string
	shaStart    string
	shaClose    string
	shaCancel   string
	evidenceKey []byte // HMAC key for the auction_events hash chain (T4)
}

// New connects to Redis + MySQL and loads the Lua scripts. Connections are
// retried (up to ~30s) so startup is robust against datastores still booting
// (e.g. MySQL finishing first-run init after its healthcheck flips healthy).
// evidenceKey is the HMAC key for the auction_events hash chain (T4); the writer
// (persistence worker) and any verifier must use the same key, so it is threaded
// in at construction rather than set later.
func New(ctx context.Context, redisAddr, mysqlDSN, evidenceKey string) (*Store, error) {
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	if err := pingWithRetry(ctx, "redis", func(c context.Context) error { return rdb.Ping(c).Err() }); err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", mysqlDSN)
	if err != nil {
		return nil, fmt.Errorf("mysql open: %w", err)
	}
	if err := pingWithRetry(ctx, "mysql", db.PingContext); err != nil {
		return nil, err
	}
	s := &Store{rdb: rdb, db: db, evidenceKey: []byte(evidenceKey)}
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
	return s.ensureColumn(ctx, "auction_rules", "auction_mode", "VARCHAR(32) NOT NULL DEFAULT 'first_price'")
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

// ResetAuctionRedisState clears ephemeral hot-path Redis state for one auction so it
// can be rebuilt deterministically (eg. local smoke reruns). This intentionally
// removes stream, leaderboard, and dedupe keys and untracks any timer index
// membership. It does NOT alter durable MySQL rows.
func (s *Store) ResetAuctionRedisState(ctx context.Context, aid string) error {
	if err := s.UntrackActive(ctx, aid); err != nil {
		return err
	}
	if _, err := s.rdb.Del(ctx, stateKey(aid), lbKey(aid), streamKey(aid)).Result(); err != nil {
		return err
	}
	pattern := fmt.Sprintf("auction:{%s}:dedupe:*", aid)
	var cursor uint64
	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, pattern, 200).Result()
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			if _, err := s.rdb.Del(ctx, keys...).Result(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
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

// CloseAuction runs close_auction.lua (Timer hammer). Returns the code and, on
// ERR_NOT_DUE, the current endAtMs so the caller can refresh the active score
// (anti-snipe may have moved it forward since the scan).
func (s *Store) CloseAuction(ctx context.Context, aid string) (string, int64, error) {
	arr, err := s.eval(ctx, s.shaClose, []string{stateKey(aid), streamKey(aid), lbKey(aid)}, PubChannel(aid))
	if err != nil {
		return "", 0, err
	}
	c := luaStr(arr[0])
	if c == model.CodeErrNotDue && len(arr) >= 2 {
		return c, luaInt(arr[1]), nil
	}
	return c, 0, nil
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

// LeaderEntry is one leaderboard row (highest accepted bid per user).
type LeaderEntry struct {
	UserID      string `json:"userId"`
	AmountCents string `json:"amountCents"`
}

// Leaderboard returns the top-n bidders by accepted max amount, descending.
// Money is a string at the boundary (proto/ws-envelope.md money-as-string).
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
	mode := model.CanonicalAuctionMode(m["auctionMode"])
	if mode != model.AuctionModeFirstPrice && mode != model.AuctionModeSecondPrice {
		mode = model.AuctionModeFirstPrice
	}
	var capCents *string
	if cap := moneyOrZero(m["capPriceCents"]); cap != "0" {
		capCents = &cap
	}
	return &model.RoomSnapshotRules{
		StepCents:         moneyOrZero(m["incrementCents"]),
		CapCents:          capCents,
		ReserveCents:      moneyOrZero(m["startPriceCents"]),
		AuctionMode:       mode,
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
	start := "-"
	if lastID != "" {
		start = "(" + lastID
	}
	msgs, err := s.rdb.XRange(ctx, streamKey(aid), start, "+").Result()
	if err != nil {
		return nil, lastID, err
	}
	out := make([]StreamEvent, 0, len(msgs))
	newLast := lastID
	for _, m := range msgs {
		out = append(out, StreamEvent{
			ID:      m.ID,
			Seq:     parseInt(valStr(m.Values, "seq")),
			Type:    valStr(m.Values, "type"),
			Payload: valStr(m.Values, "payload"),
		})
		newLast = m.ID
	}
	return out, newLast, nil
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
