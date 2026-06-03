// Package model holds pure, dependency-free contract types: canonical auction
// states, the WS envelope, and wire constants. Mirrors proto/ws-envelope.md,
// proto/error-codes.md and docs/state-machine.md.
package model

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"strings"
	"strconv"
	"time"
)

// Canonical auction states (docs/state-machine.md). No BIDDING/HAMMERED/PASSED/RESERVE_NOT_MET.
const (
	StateDraft        = "DRAFT"
	StateScheduled    = "SCHEDULED"
	StateLive         = "LIVE"
	StateSold         = "SOLD"
	StateNoBid        = "NO_BID"
	StateCancelled    = "CANCELLED"
	StateOrderCreated = "ORDER_CREATED"
)

// IsTerminal reports whether new bids must be rejected with ERR_NOT_LIVE.
func IsTerminal(s string) bool {
	switch s {
	case StateSold, StateNoBid, StateCancelled, StateOrderCreated:
		return true
	}
	return false
}

// WS message types (SCREAMING_SNAKE — proto/ws-envelope.md).
const (
	TypeRoomJoin         = "ROOM_JOIN"
	TypeBidPlace         = "BID_PLACE"
	TypePing             = "PING"
	TypeRoomSnapshot     = "ROOM_SNAPSHOT"
	TypeBidAccepted      = "BID_ACCEPTED"
	TypeBidRejected      = "BID_REJECTED"
	TypeAuctionExtended  = "AUCTION_EXTENDED"  // anti-snipe extension (event, not a state)
	TypeAuctionSold      = "AUCTION_SOLD"      // terminal: cap-hit / hammer
	TypeAuctionNoBid     = "AUCTION_NO_BID"    // terminal: timer closed with no bids (T3)
	TypeAuctionCancelled = "AUCTION_CANCELLED" // terminal: seller/admin cancel (T3)
	// T7 §4.2: AI commentary broadcast. Non-authoritative, no seq slot
	// (`seq: null`), bid path NEVER awaits this. Spec lives in
	// proto/ai-events.md §POST /llm/auctioneer.
	TypeAICommentary = "AI_COMMENTARY"
	TypePong         = "PONG"
)

// Wire / result codes (proto/error-codes.md). T1 subset + T2 (OK_EXTENDED/OK_SOLD).
const (
	CodeOKAccepted         = "OK_ACCEPTED"
	CodeOKExtended         = "OK_EXTENDED"  // accepted + endAtMs extended (anti-snipe)
	CodeOKSold             = "OK_SOLD"      // accepted + terminal SOLD (cap-hit) / hammer (T3)
	CodeOKNoBid            = "OK_NO_BID"    // close_auction: timer closed, no bids (T3)
	CodeOKCancelled        = "OK_CANCELLED" // cancel_auction: terminal cancel (T3)
	CodeOKFrozen           = "OK_FROZEN"
	CodeOKLive             = "OK_LIVE"
	CodeDuplicate          = "DUPLICATE"
	CodeErrNotLive         = "ERR_NOT_LIVE"
	CodeErrAfterEnd        = "ERR_AFTER_END"
	CodeErrTooLow          = "ERR_TOO_LOW"
	CodeErrBadState        = "ERR_BAD_STATE"
	CodeErrNotAllow        = "ERR_NOT_ALLOWED"
	CodeErrNotDue          = "ERR_NOT_DUE"          // close_auction before expiry (engine retries) (T3)
	CodeErrAlreadyTerminal = "ERR_ALREADY_TERMINAL" // close/cancel on a terminal auction (engine no-op) (T3)
	CodeErrPaused          = "ERR_AUCTION_PAUSED"
	CodeErrInternal        = "ERR_INTERNAL"            // dispatcher/store transport error (wire-only)
	CodeErrFacts           = "ERR_FACTS_NOT_CONFIRMED" // freeze before seller confirmed AI facts
	CodeErrBadInput        = "ERR_BAD_INPUT"           // malformed client message (missing/invalid fields)
	CodeErrRateLimited     = "ERR_RATE_LIMITED"
)

const (
	AuctionModeFirstPrice  = "first_price"
	AuctionModeSecondPrice = "second_price"
)

// SchemaVersion is the WS wire-protocol schema version, stamped onto every
// outgoing envelope so clients can detect a protocol mismatch and evolve safely.
// Bump on a breaking envelope change (all-member approve).
const SchemaVersion = 1

// Envelope is the WS message frame. Money fields inside Data are strings.
type Envelope struct {
	Type         string          `json:"type"`
	AuctionID    string          `json:"auctionId,omitempty"`
	RequestID    string          `json:"requestId,omitempty"`
	Seq          int64           `json:"seq,omitempty"`
	ServerTimeMs int64           `json:"serverTimeMs"`
	Data         json.RawMessage `json:"data,omitempty"`
}

// MarshalJSON stamps schemaVersion onto every outgoing envelope (one place, so no
// construction site can forget it). Clients ignore the field if they don't need it.
func (e Envelope) MarshalJSON() ([]byte, error) {
	type alias Envelope // avoid recursion
	return json.Marshal(struct {
		SchemaVersion int `json:"schemaVersion"`
		alias
	}{SchemaVersion: SchemaVersion, alias: alias(e)})
}

// NewEnvelope builds an Envelope, JSON-encoding data into Data.
func NewEnvelope(typ, auctionID string, seq int64, data any) (Envelope, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		Type:         typ,
		AuctionID:    auctionID,
		Seq:          seq,
		ServerTimeMs: time.Now().UnixMilli(),
		Data:         raw,
	}, nil
}

// --- WS data payloads ---

type RoomJoinData struct {
	AuctionID string `json:"auctionId"`
	LastSeq   int64  `json:"lastSeq,omitempty"`
}

type BidPlaceData struct {
	ClientBidID string `json:"clientBidId"`
	AmountCents string `json:"amountCents"`
}

type BidAcceptedData struct {
	Seq          int64  `json:"seq"`
	UserID       string `json:"userId"`
	DisplayName  string `json:"displayName"`
	AmountCents  string `json:"amountCents"`
	EndAtMs      int64  `json:"endAtMs"`
	Status       string `json:"status"`
	ServerTimeMs int64  `json:"serverTimeMs"` // Redis TIME at adjudication (Lua-authoritative)
}

type BidRejectedData struct {
	Code string `json:"code"`
}

// AuctionExtendedData is the anti-snipe event payload: the new endAtMs and the
// running extension count. It is an event, not a state (the auction stays LIVE).
type AuctionExtendedData struct {
	Seq          int64 `json:"seq"`
	EndAtMs      int64 `json:"endAtMs"`
	ExtendCount  int64 `json:"extendCount"`
	ServerTimeMs int64 `json:"serverTimeMs"`
}

// AuctionSoldData is the terminal SOLD event payload (cap-hit buy-now in T2; the
// Timer Worker hammer reuses it in T3).
type AuctionSoldData struct {
	Seq          int64  `json:"seq"`
	WinnerID     string `json:"winnerId"`
	AmountCents  string `json:"amountCents"`
	Status       string `json:"status"`
	ServerTimeMs int64  `json:"serverTimeMs"`
}

// AuctionNoBidData is the terminal NO_BID event payload (Timer closed a live
// auction that received no bids, T3).
type AuctionNoBidData struct {
	Seq          int64  `json:"seq"`
	Status       string `json:"status"`
	ServerTimeMs int64  `json:"serverTimeMs"`
}

// AuctionCancelledData is the terminal CANCELLED event payload (seller/admin
// cancel, T3).
type AuctionCancelledData struct {
	Seq          int64  `json:"seq"`
	Status       string `json:"status"`
	ServerTimeMs int64  `json:"serverTimeMs"`
}

// PubMessage is the Pub/Sub fanout envelope written by the Lua hot-path scripts
// and consumed by the gateway subscriber. It carries the wire type so one
// channel can fan out BID_ACCEPTED / AUCTION_EXTENDED / AUCTION_SOLD without the
// subscriber re-deriving the type. The Stream remains the durable source of
// truth; this is only a fanout hint (RFC v2 boundary: Pub/Sub non-authoritative).
type PubMessage struct {
	Type string          `json:"type"`
	Seq  int64           `json:"seq"`
	Data json.RawMessage `json:"data"`
}

type RoomSnapshotData struct {
	Status            string             `json:"status"`
	CurrentPriceCents string             `json:"currentPriceCents"`
	WinnerID          string             `json:"winnerId"`
	EndAtMs           int64              `json:"endAtMs"`
	Seq               int64              `json:"seq"`
	Rules             *RoomSnapshotRules `json:"rules,omitempty"`
}

type RoomSnapshotRules struct {
	StepCents string  `json:"stepCents"`
	CapCents  *string `json:"capCents"`
	// ReserveCents mirrors StartPriceCents until a separate reserve rule lands.
	ReserveCents      string `json:"reserveCents"`
	AuctionMode       string `json:"auctionMode"`
	MaxExtensions     int64  `json:"maxExtensions"`
	AntiSnipeWindowMs int64  `json:"antiSnipeWindowMs"`
}

// --- REST DTOs ---

// Cents is money in integer cents. It is a STRING at every JSON (JS-visible)
// boundary per the money-as-string invariant, but an int64 internally and in
// SQL (driver.Valuer + sql.Scanner). UnmarshalJSON also accepts a bare number
// so older clients don't break.
type Cents int64

// MaxMoneyCents bounds every money value. Above 2^53-1 the value is not exactly
// representable as a float64, and the hot path passes through Lua numbers and
// Redis ZSET scores (both float64) — so amounts above this would lose integer
// precision in price/leaderboard. ~9.0e15 cents (~$90T) is far beyond any real
// auction. Enforced at the gateway, REST rules, and defensively in Lua.
const MaxMoneyCents Cents = 1<<53 - 1 // 9007199254740991

func (c Cents) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(strconv.FormatInt(int64(c), 10))), nil
}

func (c *Cents) UnmarshalJSON(b []byte) error {
	s := string(b)
	if len(s) >= 2 && s[0] == '"' { // quoted string form
		s = s[1 : len(s)-1]
	}
	if s == "" || s == "null" {
		*c = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid cents %q: %w", s, err)
	}
	*c = Cents(n)
	return nil
}

func (c *Cents) Scan(v any) error {
	switch x := v.(type) {
	case int64:
		*c = Cents(x)
	case []byte:
		n, err := strconv.ParseInt(string(x), 10, 64)
		if err != nil {
			return fmt.Errorf("invalid cents bytes %q: %w", x, err)
		}
		*c = Cents(n)
	case nil:
		*c = 0
	default:
		return fmt.Errorf("cannot scan %T into Cents", v)
	}
	return nil
}

func (c Cents) Value() (driver.Value, error) { return int64(c), nil }

type Rules struct {
	StartPriceCents Cents `json:"startPriceCents"`
	IncrementCents  Cents `json:"incrementCents"`
	CapPriceCents   Cents `json:"capPriceCents"`
	DurationSec     int64 `json:"durationSec"`
	// AuctionMode changes terminal payment logic only. Empty means first-price.
	// first_price: winner pays their bid; second_price: winner pays runner-up
	// (or reserve/start price if no runner-up).
	AuctionMode    string `json:"auctionMode,omitempty"`
	ExtendWindowSec int64 `json:"extendWindowSec"`
	ExtendSec       int64 `json:"extendSec"`
	// MaxExtensions caps anti-snipe extensions to bound an auction's lifetime
	// (two bidders bouncing the price inside the window could otherwise extend
	// forever). 0 = unlimited (back-compat). Once reached, an in-window bid is
	// accepted as a normal bid (no endAtMs bump, no AUCTION_EXTENDED).
	MaxExtensions int64 `json:"maxExtensions"`
}

func (r Rules) RoomSnapshotRules() RoomSnapshotRules {
	var capCents *string
	if r.CapPriceCents > 0 {
		c := strconv.FormatInt(int64(r.CapPriceCents), 10)
		capCents = &c
	}
	return RoomSnapshotRules{
		StepCents:         strconv.FormatInt(int64(r.IncrementCents), 10),
		CapCents:          capCents,
		ReserveCents:      strconv.FormatInt(int64(r.StartPriceCents), 10),
		AuctionMode:       r.AuctionModeOrDefault(),
		MaxExtensions:     r.MaxExtensions,
		AntiSnipeWindowMs: r.ExtendWindowSec * 1000,
	}
}

func (r Rules) AuctionModeOrDefault() string {
	return CanonicalAuctionMode(r.AuctionMode)
}

func CanonicalAuctionMode(mode string) string {
	mode = strings.TrimSpace(strings.ToLower(mode))
	if mode == "" {
		return AuctionModeFirstPrice
	}
	mode = strings.ReplaceAll(mode, "-", "_")
	switch mode {
	case AuctionModeFirstPrice, "first", "firstprice":
		return AuctionModeFirstPrice
	case AuctionModeSecondPrice, "vickrey", "second", "secondprice":
		return AuctionModeSecondPrice
	default:
		return mode
	}
}

// Validate enforces the rule-DSL invariants the Lua hot path assumes, so a
// misconfigured auction is rejected at creation rather than producing a live but
// unwinnable room. `capPriceCents == 0` means "no buy-now ceiling".
func (r Rules) Validate() error {
	switch r.AuctionModeOrDefault() {
	case AuctionModeFirstPrice, AuctionModeSecondPrice:
	default:
		return fmt.Errorf("auctionMode must be one of: %s, %s", AuctionModeFirstPrice, AuctionModeSecondPrice)
	}
	switch {
	case r.StartPriceCents < 0:
		return fmt.Errorf("startPriceCents must be >= 0")
	case r.IncrementCents <= 0:
		// increment 0 would let bids "win" at the current price (no real raise).
		return fmt.Errorf("incrementCents must be > 0")
	case r.CapPriceCents < 0:
		return fmt.Errorf("capPriceCents must be >= 0")
	case r.CapPriceCents > 0 && r.CapPriceCents <= r.StartPriceCents:
		// cap is "buy it now"; it must sit above the start price. A cap below the
		// first increment is allowed (the cap-aware required price lets a buy-now
		// bid reach it — see place_bid.lua), so only require cap > start.
		return fmt.Errorf("capPriceCents must be > startPriceCents (or 0 for no cap)")
	case r.StartPriceCents > MaxMoneyCents || r.IncrementCents > MaxMoneyCents || r.CapPriceCents > MaxMoneyCents:
		return fmt.Errorf("money fields must be <= MaxMoneyCents (%d)", int64(MaxMoneyCents))
	case r.CapPriceCents == 0 && r.StartPriceCents > MaxMoneyCents-r.IncrementCents:
		// No cap: the first required bid is startPrice+increment and must be
		// reachable (<= MaxMoneyCents), else every bid is rejected and the auction
		// is unwinnable. (Written as subtraction to avoid overflow; both operands
		// are already <= MaxMoneyCents at this point.) With a cap the required price
		// clamps to the cap, so cap-below-first-increment stays valid — don't
		// blanket-reject it here.
		return fmt.Errorf("startPriceCents + incrementCents must be <= MaxMoneyCents when capPriceCents is 0")
	case r.DurationSec <= 0:
		return fmt.Errorf("durationSec must be > 0")
	case r.ExtendWindowSec < 0 || r.ExtendSec < 0:
		return fmt.Errorf("extendWindowSec and extendSec must be >= 0")
	case r.MaxExtensions < 0:
		return fmt.Errorf("maxExtensions must be >= 0 (0 = unlimited)")
	}
	return nil
}
