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
	cfg     roomStatePatchConfig
	pending map[string]model.RoomStatePatchData
}

func newRoomStatePatchCoalescer(cfg roomStatePatchConfig) *roomStatePatchCoalescer {
	return &roomStatePatchCoalescer{
		cfg:     cfg,
		pending: make(map[string]model.RoomStatePatchData),
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

// offerBidAccepted stores the latest accepted-bid state for a high-fanout room
// and returns true when the caller should suppress the per-bid room broadcast.
// Terminal cap-hit BID_ACCEPTED(status=SOLD) is never coalesced.
func (p *roomStatePatchCoalescer) offerBidAccepted(h *Hub, aid string, e store.StreamEvent) bool {
	if !p.enabled() || e.Type != model.TypeBidAccepted || h.viewerCount(aid) < p.cfg.minViewers {
		return false
	}
	var bid model.BidAcceptedData
	if err := json.Unmarshal([]byte(e.Payload), &bid); err != nil {
		return false
	}
	if bid.Status == model.StateSold {
		return false
	}
	next := model.RoomStatePatchData{
		Seq:               e.Seq,
		Status:            bid.Status,
		CurrentPriceCents: bid.AmountCents,
		WinnerID:          bid.UserID,
		WinnerDisplayName: bid.DisplayName,
		EndAtMs:           bid.EndAtMs,
		BidCountDelta:     1,
		ServerTimeMs:      bid.ServerTimeMs,
	}
	if prev, ok := p.pending[aid]; ok {
		next.BidCountDelta = prev.BidCountDelta + 1
	}
	p.pending[aid] = next
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
	p.pending = make(map[string]model.RoomStatePatchData, len(pending))
	for aid, patch := range pending {
		p.broadcast(h, m, aid, patch)
	}
}

func (p *roomStatePatchCoalescer) broadcast(h *Hub, m *metrics.Registry, aid string, patch model.RoomStatePatchData) {
	env, err := model.NewEnvelope(model.TypeRoomStatePatch, aid, patch.Seq, patch)
	if err != nil {
		log.Printf("room-state-patch envelope %s seq=%d: %v", aid, patch.Seq, err)
		return
	}
	b, err := json.Marshal(env)
	if err != nil {
		log.Printf("room-state-patch marshal %s seq=%d: %v", aid, patch.Seq, err)
		return
	}
	h.broadcast(aid, b)
	if m != nil && patch.ServerTimeMs > 0 {
		m.BroadcastLatency.Observe(time.Since(time.UnixMilli(patch.ServerTimeMs)))
	}
}
