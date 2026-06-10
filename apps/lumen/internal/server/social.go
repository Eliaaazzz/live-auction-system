package server

// social.go — room social channel (#261-7/8/10): comments (弹幕), gifts and
// likes were client-local before, so 买家A sending a gift was invisible on
// 买家B's phone and like counts never agreed across devices. This adds the
// smallest server piece that makes them REAL:
//
//   POST /api/auctions/{id}/social  {kind, text? | giftId/giftName/giftEmoji? | delta?}
//     → broadcasts a ROOM_SOCIAL envelope to every WS client in the room.
//
// Contract guarantees (mirrors AI_COMMENTARY's precedent):
//   - additive event type under SchemaVersion 2 (old clients ignore it);
//   - NO seq slot — exempt from the client seqguard, never in the Stream,
//     never in the evidence chain;
//   - the bid path neither reads nor awaits any of this (V9 P3 stays intact);
//   - like totals are in-process state (single-process demo deploy). With N
//     gateways each would count its own likes — acceptable for the demo;
//     a Redis INCR is the clean follow-up if we shard.

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// socialState holds per-auction like counters. Nil-safe: a zero Server in
// unit tests can call likeCount/addLikes through a nil pointer.
type socialState struct {
	mu    sync.Mutex
	likes map[string]int64
}

func newSocialState() *socialState {
	return &socialState{likes: make(map[string]int64)}
}

// addLikes applies a delta and returns the new clamped-at-zero total.
func (ss *socialState) addLikes(aid string, delta int64) int64 {
	if ss == nil {
		return 0
	}
	ss.mu.Lock()
	defer ss.mu.Unlock()
	n := ss.likes[aid] + delta
	if n < 0 {
		n = 0
	}
	ss.likes[aid] = n
	return n
}

func (ss *socialState) likeCount(aid string) int64 {
	if ss == nil {
		return 0
	}
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.likes[aid]
}

// sanitizeSocialText flattens control characters/newlines to spaces, collapses
// runs of whitespace, trims, and caps the result at maxRunes. Pure + tested.
func sanitizeSocialText(s string, maxRunes int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || r < 0x20 {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	rs := []rune(s)
	if len(rs) > maxRunes {
		rs = rs[:maxRunes]
	}
	return string(rs)
}

// clampLikeDelta squeezes an arbitrary client delta into {-1, +1} (0 → +1 so a
// legacy body without delta still counts as one like). Pure + tested.
func clampLikeDelta(d int64) int64 {
	if d < 0 {
		return -1
	}
	return 1
}

// handleSocial — POST /api/auctions/{id}/social. Auth-gated like the bid lane
// so every social event carries a real userId + display name (排名/弹幕跨端
// 同名同脸). The auction must exist; terminal rooms still accept social events
// (people cheer at the hammer).
func (s *Server) handleSocial(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	if _, err := s.st.GetAuction(r.Context(), aid); err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "auction not found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	var body struct {
		Kind      string `json:"kind"`
		Text      string `json:"text"`
		GiftID    string `json:"giftId"`
		GiftName  string `json:"giftName"`
		GiftEmoji string `json:"giftEmoji"`
		Delta     int64  `json:"delta"`
	}
	if !readJSON(w, r, &body) {
		return
	}

	display := userID
	if nick, err := s.st.UserNickname(r.Context(), userID); err == nil && nick != "" {
		display = nick
	}

	data := model.RoomSocialData{
		Kind:         body.Kind,
		UserID:       userID,
		DisplayName:  display,
		LikeCount:    s.social.likeCount(aid),
		ServerTimeMs: time.Now().UnixMilli(),
	}
	switch body.Kind {
	case "comment":
		data.Text = sanitizeSocialText(body.Text, 60)
		if data.Text == "" {
			writeErr(w, http.StatusBadRequest, "empty comment")
			return
		}
	case "gift":
		data.GiftID = sanitizeSocialText(body.GiftID, 24)
		data.GiftName = sanitizeSocialText(body.GiftName, 24)
		data.GiftEmoji = sanitizeSocialText(body.GiftEmoji, 8)
		if data.GiftName == "" {
			writeErr(w, http.StatusBadRequest, "missing gift")
			return
		}
	case "like":
		data.LikeDelta = clampLikeDelta(body.Delta)
		data.LikeCount = s.social.addLikes(aid, data.LikeDelta)
	default:
		writeErr(w, http.StatusBadRequest, `kind must be "comment" | "gift" | "like"`)
		return
	}

	s.broadcastSocial(aid, data)
	writeJSON(w, http.StatusOK, map[string]any{"code": "OK", "likeCount": data.LikeCount})
}

// broadcastSocial fans a ROOM_SOCIAL envelope out to the room. Seq stays 0 →
// omitted on the wire (`omitempty`), exactly like AI_COMMENTARY.
func (s *Server) broadcastSocial(aid string, data model.RoomSocialData) {
	if s.hub == nil {
		return
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	env := model.Envelope{
		Type:         model.TypeRoomSocial,
		AuctionID:    aid,
		ServerTimeMs: time.Now().UnixMilli(),
		Data:         raw,
	}
	b, err := json.Marshal(env)
	if err != nil {
		return
	}
	s.hub.broadcast(aid, b)
}
