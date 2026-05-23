// Package model holds pure, dependency-free contract types: canonical auction
// states, the WS envelope, and wire constants. Mirrors proto/ws-envelope.md,
// proto/error-codes.md and docs/state-machine.md.
package model

import (
	"encoding/json"
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

type Rules struct {
	StartPriceCents int64 `json:"startPriceCents"`
	IncrementCents  int64 `json:"incrementCents"`
	CapPriceCents   int64 `json:"capPriceCents"`
	DurationSec     int64 `json:"durationSec"`
	ExtendWindowSec int64 `json:"extendWindowSec"`
	ExtendSec       int64 `json:"extendSec"`
}
