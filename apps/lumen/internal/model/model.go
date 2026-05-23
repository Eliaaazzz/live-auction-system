// Package model holds pure, dependency-free contract types: canonical auction
// states, the WS envelope, and wire constants. Mirrors proto/ws-envelope.md,
// proto/error-codes.md and docs/state-machine.md.
package model

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
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
	TypeRoomJoin     = "ROOM_JOIN"
	TypeBidPlace     = "BID_PLACE"
	TypePing         = "PING"
	TypeRoomSnapshot = "ROOM_SNAPSHOT"
	TypeBidAccepted  = "BID_ACCEPTED"
	TypeBidRejected  = "BID_REJECTED"
	TypePong         = "PONG"
)

// Wire / result codes (proto/error-codes.md). T1 subset + the frozen set.
const (
	CodeOKAccepted  = "OK_ACCEPTED"
	CodeOKFrozen    = "OK_FROZEN"
	CodeOKLive      = "OK_LIVE"
	CodeDuplicate   = "DUPLICATE"
	CodeErrNotLive  = "ERR_NOT_LIVE"
	CodeErrAfterEnd = "ERR_AFTER_END"
	CodeErrTooLow   = "ERR_TOO_LOW"
	CodeErrBadState = "ERR_BAD_STATE"
	CodeErrNotAllow = "ERR_NOT_ALLOWED"
	CodeErrPaused   = "ERR_AUCTION_PAUSED"
	CodeErrInternal = "ERR_INTERNAL"            // dispatcher/store transport error (wire-only)
	CodeErrFacts    = "ERR_FACTS_NOT_CONFIRMED" // freeze before seller confirmed AI facts
)

// Envelope is the WS message frame. Money fields inside Data are strings.
type Envelope struct {
	Type         string          `json:"type"`
	AuctionID    string          `json:"auctionId,omitempty"`
	RequestID    string          `json:"requestId,omitempty"`
	Seq          int64           `json:"seq,omitempty"`
	ServerTimeMs int64           `json:"serverTimeMs"`
	Data         json.RawMessage `json:"data,omitempty"`
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
	Seq         int64  `json:"seq"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	AmountCents string `json:"amountCents"`
	EndAtMs     int64  `json:"endAtMs"`
	Status      string `json:"status"`
}

type BidRejectedData struct {
	Code string `json:"code"`
}

type RoomSnapshotData struct {
	Status            string `json:"status"`
	CurrentPriceCents string `json:"currentPriceCents"`
	WinnerID          string `json:"winnerId"`
	EndAtMs           int64  `json:"endAtMs"`
	Seq               int64  `json:"seq"`
}

// --- REST DTOs ---

// Cents is money in integer cents. It is a STRING at every JSON (JS-visible)
// boundary per the money-as-string invariant, but an int64 internally and in
// SQL (driver.Valuer + sql.Scanner). UnmarshalJSON also accepts a bare number
// so older clients don't break.
type Cents int64

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
		n, _ := strconv.ParseInt(string(x), 10, 64)
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
	ExtendWindowSec int64 `json:"extendWindowSec"`
	ExtendSec       int64 `json:"extendSec"`
}
