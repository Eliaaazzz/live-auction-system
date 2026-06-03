package server

import (
	"encoding/json"
	"log"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

const (
	defaultRoomStatePatchIntervalMs = 50
	defaultRoomStatePatchMinViewers = 1000
)

type roomStatePatchConfig struct {
	interval   time.Duration
	minViewers int
}

func roomStatePatchConfigFromEnv() roomStatePatchConfig {
	return roomStatePatchConfig{
		interval:   time.Duration(envIntAllowZero("ROOM_STATE_PATCH_INTERVAL_MS", defaultRoomStatePatchIntervalMs)) * time.Millisecond,
		minViewers: envIntAllowZero("ROOM_STATE_PATCH_MIN_VIEWERS", defaultRoomStatePatchMinViewers),
	}
}

func (c roomStatePatchConfig) enabled() bool {
	return c.interval > 0 && c.minViewers > 0
}

type roomStatePatchCoalescer struct {
	cfg       roomStatePatchConfig
	pending   map[string]pendingRoomStatePatch
	bidTotals map[string]int64
}

type pendingRoomStatePatch struct {
	data              model.RoomStatePatchData
	firstServerTimeMs int64
}

func newRoomStatePatchCoalescer(cfg roomStatePatchConfig) *roomStatePatchCoalescer {
	return &roomStatePatchCoalescer{
		cfg:       cfg,
		pending:   make(map[string]pendingRoomStatePatch),
		bidTotals: make(map[string]int64),
	}
}

func (p *roomStatePatchCoalescer) enabled() bool {
	return p != nil && p.cfg.enabled()
}

func (p *roomStatePatchCoalescer) interval() time.Duration {
	if !p.enabled() {
		return 0
	}
	return p.cfg.interval
}

// offer stores a high-fanout room projection and returns true when the caller
// should suppress the per-event room broadcast. Terminal events are never
// coalesced; an AUCTION_EXTENDED immediately after a coalesced bid is folded
// into that pending state patch so anti-snipe does not reintroduce O(N*M) fanout.
func (p *roomStatePatchCoalescer) offer(h *Hub, aid string, e store.StreamEvent) bool {
	if !p.enabled() {
		return false
	}
	switch e.Type {
	case model.TypeBidAccepted:
		return p.offerBidAccepted(h, aid, e)
	case model.TypeAuctionExtended:
		if h.viewerCount(aid) < p.cfg.minViewers {
			return false
		}
		return p.offerAuctionExtended(aid, e)
	default:
		return false
	}
}

func (p *roomStatePatchCoalescer) offerBidAccepted(h *Hub, aid string, e store.StreamEvent) bool {
	var bid model.BidAcceptedData
	if err := json.Unmarshal([]byte(e.Payload), &bid); err != nil {
		return false
	}
	if bid.Status == model.StateSold {
		return false
	}
	if bid.BidCount > 0 {
		p.bidTotals[aid] = bid.BidCount
	} else {
		p.bidTotals[aid]++
	}
	if h.viewerCount(aid) < p.cfg.minViewers {
		return false
	}
	next := model.RoomStatePatchData{
		FromSeq:           e.Seq,
		Seq:               e.Seq,
		Status:            bid.Status,
		CurrentPriceCents: bid.AmountCents,
		WinnerID:          bid.UserID,
		WinnerDisplayName: bid.DisplayName,
		EndAtMs:           bid.EndAtMs,
		BidCountDelta:     1,
		BidCountTotal:     p.bidTotals[aid],
		ServerTimeMs:      bid.ServerTimeMs,
	}
	if prev, ok := p.pending[aid]; ok {
		next.FromSeq = prev.data.FromSeq
		next.BidCountDelta = prev.data.BidCountDelta + 1
		p.pending[aid] = pendingRoomStatePatch{
			data:              next,
			firstServerTimeMs: prev.firstServerTimeMs,
		}
		return true
	}
	p.pending[aid] = pendingRoomStatePatch{
		data:              next,
		firstServerTimeMs: bid.ServerTimeMs,
	}
	return true
}

func (p *roomStatePatchCoalescer) offerAuctionExtended(aid string, e store.StreamEvent) bool {
	prev, ok := p.pending[aid]
	if !ok {
		return false
	}
	var ext model.AuctionExtendedData
	if err := json.Unmarshal([]byte(e.Payload), &ext); err != nil {
		return false
	}
	prev.data.Seq = e.Seq
	prev.data.EndAtMs = ext.EndAtMs
	prev.data.ExtendCount = ext.ExtendCount
	prev.data.ServerTimeMs = ext.ServerTimeMs
	p.pending[aid] = prev
	return true
}

func (p *roomStatePatchCoalescer) flushAid(h *Hub, m *metrics.Registry, aid string) {
	if p == nil {
		return
	}
	patch, ok := p.pending[aid]
	if !ok {
		return
	}
	delete(p.pending, aid)
	p.broadcast(h, m, aid, patch)
}

func (p *roomStatePatchCoalescer) flushAll(h *Hub, m *metrics.Registry) {
	if p == nil || len(p.pending) == 0 {
		return
	}
	pending := p.pending
	p.pending = make(map[string]pendingRoomStatePatch, len(pending))
	for aid, patch := range pending {
		p.broadcast(h, m, aid, patch)
	}
}

func (p *roomStatePatchCoalescer) broadcast(h *Hub, m *metrics.Registry, aid string, patch pendingRoomStatePatch) {
	env, err := model.NewEnvelope(model.TypeRoomStatePatch, aid, patch.data.Seq, patch.data)
	if err != nil {
		log.Printf("room-state-patch envelope %s seq=%d: %v", aid, patch.data.Seq, err)
		return
	}
	b, err := json.Marshal(env)
	if err != nil {
		log.Printf("room-state-patch marshal %s seq=%d: %v", aid, patch.data.Seq, err)
		return
	}
	h.broadcast(aid, b)
	if m != nil {
		m.RoomStatePatches.Inc()
		m.RoomStatePatchBids.Add(patch.data.BidCountDelta)
		if patch.firstServerTimeMs > 0 {
			m.RoomStatePatch.Observe(time.Since(time.UnixMilli(patch.firstServerTimeMs)))
		}
	}
}
