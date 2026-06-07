package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// POST /api/login {nickname} -> {userId, token, nickname}. Public buyer login.
// This keeps production dev-login disabled while still allowing browser users
// to obtain a user-scoped bidding token. Seller/admin roles are not minted here.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Nickname string `json:"nickname"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	nickname := strings.TrimSpace(body.Nickname)
	if nickname == "" {
		writeErr(w, http.StatusBadRequest, "nickname required")
		return
	}
	userID := "user_" + slug(nickname)
	if err := s.st.UpsertUser(r.Context(), userID, nickname, "user"); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"userId":   userID,
		"token":    auth.Token(s.cfg.JWTSecret, userID),
		"nickname": nickname,
	})
}

// POST /api/auctions/{id}/bids {clientBidId, amountCents} -> BID_ACCEPTED/BID_REJECTED envelope.
//
// This is the command lane for high-fanout rooms: the Redis Lua adjudicator and
// Stream/PubSub fanout remain unchanged, but the bidder-visible outcome is
// returned on the HTTP response instead of sharing the room-broadcast WS stream.
// A single TCP WS stream cannot let a direct ACK overtake already-flushed public
// patches, so large-room clients should use this endpoint for BID_PLACE and keep
// /ws for ROOM_JOIN snapshots, patches, replay, and terminal events.
func (s *Server) handlePlaceBidHTTP(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	var body model.BidPlaceData
	if !readJSON(w, r, &body) {
		return
	}

	handlerStart := time.Now()
	ackStart := time.Now()
	amount, validAmount := canonicalAmount(body.AmountCents)
	if aid == "" || body.ClientBidID == "" || len(body.ClientBidID) > maxClientBidIDLen || !validAmount {
		writeJSON(w, http.StatusBadRequest, rejected(aid, model.CodeErrBadInput))
		if s.metrics != nil {
			s.metrics.AckLatency.Observe(time.Since(ackStart))
			s.metrics.BidsRejected.Inc()
			s.metrics.HandlerOverhead.Observe(time.Since(handlerStart))
		}
		return
	}

	display := userID
	if nick, err := s.st.UserNickname(r.Context(), userID); err == nil && nick != "" {
		display = nick
	}

	mode := s.hub.roomStateSnap(aid).mode
	if mode == "" {
		if snap, err := s.st.Snapshot(r.Context(), aid); err == nil && snap.Rules != nil {
			mode = snap.Rules.Mode
			s.hub.setMode(aid, mode)
		}
	}
	sealed := model.UsesSealedEngine(mode)
	hybrid := model.UsesHybridEngine(mode)

	scriptStart := time.Now()
	var code, payload string
	var err error
	if sealed {
		code, _, payload, err = s.st.PlaceBidSealed(r.Context(), aid, userID, body.ClientBidID, amount, display)
	} else if hybrid {
		code, _, payload, err = s.st.PlaceBidHybrid(r.Context(), aid, userID, body.ClientBidID, amount, display)
	} else {
		code, _, payload, err = s.st.PlaceBid(r.Context(), aid, userID, body.ClientBidID, amount, display)
	}
	scriptDur := time.Since(scriptStart)
	if s.metrics != nil {
		s.metrics.ScriptTime.Observe(scriptDur)
	}
	if err != nil {
		log.Printf("place_bid_http %s: %v", aid, err)
		writeJSON(w, http.StatusOK, rejected(aid, bidErrCode(err)))
		if s.metrics != nil {
			s.metrics.AckLatency.Observe(time.Since(ackStart))
			s.metrics.BidsRejected.Inc()
			s.metrics.HandlerOverhead.Observe(time.Since(handlerStart) - scriptDur)
		}
		return
	}

	switch code {
	case model.CodeOKAccepted, model.CodeOKExtended, model.CodeOKSold, model.CodeDuplicate:
		writeJSON(w, http.StatusOK, bidAccepted(aid, payload))
		if s.metrics != nil {
			s.metrics.AckLatency.Observe(time.Since(ackStart))
			if code != model.CodeDuplicate {
				s.metrics.BidsAccepted.Inc()
			}
		}
	default:
		writeJSON(w, http.StatusOK, rejected(aid, code))
		if s.metrics != nil {
			s.metrics.AckLatency.Observe(time.Since(ackStart))
			s.metrics.BidsRejected.Inc()
		}
	}
	if s.metrics != nil {
		s.metrics.HandlerOverhead.Observe(time.Since(handlerStart) - scriptDur)
	}
}

// POST /api/dev-login {nickname, role?} -> {userId, token, nickname}. Dev only.
func (s *Server) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.EnableDevLogin {
		writeErr(w, http.StatusForbidden, "dev-login disabled")
		return
	}
	var body struct {
		Nickname string `json:"nickname"`
		Role     string `json:"role"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Nickname == "" {
		writeErr(w, http.StatusBadRequest, "nickname required")
		return
	}
	role := body.Role
	if role == "" {
		role = "user"
	}
	userID := "user_" + slug(body.Nickname)
	if err := s.st.UpsertUser(r.Context(), userID, body.Nickname, role); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"userId":   userID,
		"token":    auth.Token(s.cfg.JWTSecret, userID),
		"nickname": body.Nickname,
	})
}

// POST /api/products {name, imageUrl, description} -> {productId}
func (s *Server) handleCreateProduct(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Name        string `json:"name"`
		ImageURL    string `json:"imageUrl"`
		Description string `json:"description"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	id := "prod_" + newID()
	if err := s.st.CreateProduct(r.Context(), id, userID, body.Name, body.ImageURL, body.Description); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"productId": id})
}

// POST /api/facts/draft -> proxied to ai-sidecar (mock in T1).
func (s *Server) handleFactsDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.cfg.AISidecarURL+"/facts/draft", strings.NewReader(string(body)))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "ai-sidecar unavailable")
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 1<<20))
}

// POST /api/auctions {productId, rules} -> {auctionId}
func (s *Server) handleCreateAuction(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		ProductID      string          `json:"productId"`
		Rules          model.Rules     `json:"rules"`
		FactsConfirmed bool            `json:"factsConfirmed"`
		ConfirmedFacts json.RawMessage `json:"confirmedFacts"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.ProductID == "" {
		writeErr(w, http.StatusBadRequest, "productId required")
		return
	}
	// Resolve the auction mode's strategy and apply its rule normalization (e.g.
	// Sudden Death disables anti-snipe) before validation + persistence, so the
	// stored rules already encode the mode's semantics. A valid-but-not-yet-
	// enabled mode (e.g. ALL_PAY before its phase lands) is rejected here.
	mode, ok := modeFor(body.Rules.Mode)
	if !ok {
		writeErr(w, http.StatusBadRequest, "auction mode not available yet: "+model.NormalizeMode(body.Rules.Mode))
		return
	}
	body.Rules = mode.NormalizeRules(body.Rules)
	if err := body.Rules.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	id := "auc_" + newID()
	s.prepareLiveStreamRules(id, &body.Rules)
	if err := s.st.CreateAuction(r.Context(), id, body.ProductID, userID, body.Rules, body.FactsConfirmed, string(body.ConfirmedFacts)); err != nil {
		if err == store.ErrNotFound {
			writeErr(w, http.StatusNotFound, "product not found")
			return
		}
		if err == store.ErrNotAllowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"code": model.CodeErrNotAllow})
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"auctionId": id})
}

type prequalifySealedSummary struct {
	Count       int    `json:"count"`
	MaxCents    string `json:"maxCents"`
	SecondCents string `json:"secondCents"`
	MedianCents string `json:"medianCents"`
}

type prequalifyRecommendation struct {
	ParentAuctionID            string                  `json:"parentAuctionId"`
	AdvisoryOnly               bool                    `json:"advisoryOnly"`
	RecommendedMode            string                  `json:"recommendedMode"`
	EngineModeHint             string                  `json:"engineModeHint"`
	RecommendedReserveCents    string                  `json:"recommendedReserveCents"`
	RecommendedStartPriceCents string                  `json:"recommendedStartPriceCents"`
	SealedSummary              prequalifySealedSummary `json:"sealedSummary"`
	Rationale                  string                  `json:"rationale"`
}

func prequalifyRecommendationFromReveal(parentAID string, reveal model.AuctionRevealedData) (prequalifyRecommendation, error) {
	amounts := make([]int64, 0, len(reveal.Bids))
	for _, b := range reveal.Bids {
		n, err := strconv.ParseInt(strings.TrimSpace(b.AmountCents), 10, 64)
		if err != nil || n <= 0 || n > int64(model.MaxMoneyCents) {
			continue
		}
		amounts = append(amounts, n)
	}
	if len(amounts) == 0 {
		return prequalifyRecommendation{}, store.ErrNotFound
	}
	sort.Slice(amounts, func(i, j int) bool { return amounts[i] > amounts[j] })

	max := amounts[0]
	var second int64
	if len(amounts) > 1 {
		second = amounts[1]
	}
	median := amounts[len(amounts)/2]

	reserve := median
	rationale := "sealed cluster: use the lower median as the formal open-auction floor."
	if len(amounts) == 1 {
		reserve = max
		rationale = "single sealed bid: use the only real demand signal as the formal floor."
	} else if second > 0 && max >= second*13/10 {
		reserve = second
		rationale = "sealed outlier: use second-highest as reserve so the formal auction can still climb."
	}
	if reserve <= 0 {
		reserve = max
	}

	secondText := ""
	if second > 0 {
		secondText = strconv.FormatInt(second, 10)
	}
	reserveText := strconv.FormatInt(reserve, 10)
	return prequalifyRecommendation{
		ParentAuctionID:            parentAID,
		AdvisoryOnly:               true,
		RecommendedMode:            "OPEN",
		EngineModeHint:             model.ModeEnglish,
		RecommendedReserveCents:    reserveText,
		RecommendedStartPriceCents: reserveText,
		SealedSummary: prequalifySealedSummary{
			Count:       len(amounts),
			MaxCents:    strconv.FormatInt(max, 10),
			SecondCents: secondText,
			MedianCents: strconv.FormatInt(median, 10),
		},
		Rationale: rationale,
	}, nil
}

func (s *Server) loadPrequalifyRecommendation(w http.ResponseWriter, r *http.Request, userID, parentAID string) (store.Auction, prequalifyRecommendation, bool) {
	parent, err := s.st.GetAuction(r.Context(), parentAID)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "parent auction not found")
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	if parent.SellerID != userID {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": model.CodeErrNotAllow})
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	parentRules, err := s.st.GetRules(r.Context(), parentAID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "load parent rules: "+err.Error())
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	if !model.UsesSealedEngine(parentRules.Mode) || model.NormalizeMode(parentRules.Mode) == model.ModeAllPay {
		writeErr(w, http.StatusBadRequest, "parent must be SEALED_FIRST or VICKREY (got "+model.NormalizeMode(parentRules.Mode)+")")
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	snap, err := s.st.Snapshot(r.Context(), parentAID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "read parent snapshot: "+err.Error())
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	if snap.Status != model.StateSold && snap.Status != model.StateOrderCreated {
		writeErr(w, http.StatusBadRequest, "parent auction is not terminal SOLD (status="+snap.Status+")")
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	reveal, err := s.st.LastAuctionReveal(r.Context(), parentAID)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusBadRequest, "parent has no sealed reveal to recommend from")
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "read parent reveal: "+err.Error())
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	rec, err := prequalifyRecommendationFromReveal(parentAID, reveal)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "parent has no usable sealed bids to recommend from")
		return store.Auction{}, prequalifyRecommendation{}, false
	}
	return parent, rec, true
}

func (s *Server) handlePrequalifyRecommendation(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	_, rec, ok := s.loadPrequalifyRecommendation(w, r, userID, r.PathValue("id"))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// POST /api/auctions/{id}/spawn-formal {rules{}} -> {auctionId, seededStartPriceCents, parentAuctionId}
// A terminal SEALED_FIRST/VICKREY parent seeds the formal auction from the
// sealed reveal aggregate. A positive request rules.startPriceCents is treated
// as the seller-confirmed override; otherwise the recommendation is used.
func (s *Server) handleSpawnFormal(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	parentAID := r.PathValue("id")
	parent, rec, ok := s.loadPrequalifyRecommendation(w, r, userID, parentAID)
	if !ok {
		return
	}
	if existing, err := s.st.ChildAuctionByParent(r.Context(), parentAID); err == nil {
		seeded := rec.RecommendedReserveCents
		if rules, rerr := s.st.GetRules(r.Context(), existing.ID); rerr == nil {
			seeded = strconv.FormatInt(int64(rules.StartPriceCents), 10)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"auctionId":                  existing.ID,
			"parentAuctionId":            parentAID,
			"seededStartPriceCents":      seeded,
			"recommendedReserveCents":    rec.RecommendedReserveCents,
			"recommendedStartPriceCents": rec.RecommendedStartPriceCents,
			"sealedSummary":              rec.SealedSummary,
			"reused":                     true,
		})
		return
	} else if err != store.ErrNotFound {
		writeErr(w, http.StatusInternalServerError, "check existing formal auction: "+err.Error())
		return
	}

	var body struct {
		Rules model.Rules `json:"rules"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	seededStart, perr := strconv.ParseInt(rec.RecommendedReserveCents, 10, 64)
	if perr != nil {
		writeErr(w, http.StatusInternalServerError, "parse recommended reserve: "+perr.Error())
		return
	}
	if body.Rules.StartPriceCents > 0 {
		seededStart = int64(body.Rules.StartPriceCents)
	}
	body.Rules.StartPriceCents = model.Cents(seededStart)
	mode, ok := modeFor(body.Rules.Mode)
	if !ok {
		writeErr(w, http.StatusBadRequest, "auction mode not available yet: "+model.NormalizeMode(body.Rules.Mode))
		return
	}
	body.Rules = mode.NormalizeRules(body.Rules)
	if err := body.Rules.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	newID := "auc_" + newID()
	s.prepareLiveStreamRules(newID, &body.Rules)
	if err := s.st.CreateAuction(r.Context(), newID, parent.ProductID, userID, body.Rules, true, ""); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.SetParentAuction(r.Context(), newID, parentAID); err != nil {
		writeErr(w, http.StatusInternalServerError, "link parent: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"auctionId":                  newID,
		"parentAuctionId":            parentAID,
		"seededStartPriceCents":      strconv.FormatInt(seededStart, 10),
		"recommendedReserveCents":    rec.RecommendedReserveCents,
		"recommendedStartPriceCents": rec.RecommendedStartPriceCents,
		"sealedSummary":              rec.SealedSummary,
		"reused":                     false,
	})
	return
}

// GET /api/auctions/{id}/stream -> seller/admin-only live push material.
// The public room only receives livePlayUrl from GET /api/auctions/{id}; pushUrl
// and streamKey stay off public snapshots so video remains display-only and
// outside the Redis/Lua bid hot path.
func (s *Server) handleGetAuctionStream(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	if _, ok := s.ownsAuction(w, r, aid, userID); !ok {
		return
	}
	rules, err := s.st.GetRules(r.Context(), aid)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "rules not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	livePlayURL := rules.LivePlayUrl
	if livePlayURL == "" {
		livePlayURL = s.livePlayURL(rules.LiveStreamKey)
	}
	writeJSON(w, http.StatusOK, struct {
		AuctionID   string `json:"auctionId"`
		StreamKey   string `json:"streamKey,omitempty"`
		PushURL     string `json:"pushUrl,omitempty"`
		LivePlayURL string `json:"livePlayUrl,omitempty"`
	}{
		AuctionID:   aid,
		StreamKey:   rules.LiveStreamKey,
		PushURL:     s.livePushURL(rules.LiveStreamKey),
		LivePlayURL: livePlayURL,
	})
}

func (s *Server) prepareLiveStreamRules(aid string, rules *model.Rules) {
	if rules.LiveStreamKey == "" {
		rules.LiveStreamKey = "stream_" + newID()
	}
	if rules.LivePlayUrl == "" {
		rules.LivePlayUrl = s.livePlayURL(rules.LiveStreamKey)
	}
	_ = aid // keeps the seam explicit if we later switch to deterministic keys.
}

func (s *Server) livePushURL(streamKey string) string {
	return joinStreamURL(s.cfg.LivePushURLBase, streamKey, "")
}

func (s *Server) livePlayURL(streamKey string) string {
	return joinStreamURL(s.cfg.LivePlayURLBase, streamKey, ".m3u8")
}

func joinStreamURL(base, streamKey, suffix string) string {
	if base == "" || streamKey == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(streamKey, "/") + suffix
}

// GET /api/auctions/{id} -> room snapshot from Redis (404 if unknown).
func (s *Server) handleGetAuction(w http.ResponseWriter, r *http.Request) {
	aid := r.PathValue("id")
	a, err := s.st.GetAuction(r.Context(), aid)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "auction not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	snap, err := s.st.Snapshot(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if snap.Status == "" { // not yet frozen: no Redis state, fall back to MySQL status
		snap.Status = a.Status
	}
	// Rules from MySQL: needed for the pre-freeze snapshot fallback AND for the
	// live-stream play URL (#121), which rides the REST first-paint — display-only,
	// deliberately OFF the Redis bid hot path (a frozen snapshot's Rules come from
	// Redis and don't carry it). One read here (not the hot path) is fine.
	livePlayURL := ""
	if rules, rerr := s.st.GetRules(r.Context(), aid); rerr == nil {
		livePlayURL = rules.LivePlayUrl
		if snap.Rules == nil {
			dto := rules.RoomSnapshotRules()
			snap.Rules = &dto
		}
		if snap.CurrentPriceCents == "" && (snap.Status == model.StateDraft || snap.Status == model.StateScheduled) {
			snap.CurrentPriceCents = strconv.FormatInt(int64(rules.StartPriceCents), 10)
		}
	} else if snap.Rules == nil {
		if rerr == store.ErrNotFound {
			writeErr(w, http.StatusNotFound, "rules not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, rerr.Error())
		return
	}
	// Surface the product (name / image / 介绍) so the room shows the real item
	// and the VLM page can draft facts from its image. Best-effort: a missing
	// product just yields empty fields, never a 500.
	prod, _ := s.st.GetProduct(r.Context(), a.ProductID)
	writeJSON(w, http.StatusOK, struct {
		model.RoomSnapshotData
		ProductID   string `json:"productId"`
		ProductName string `json:"productName"`
		ImageURL    string `json:"imageUrl"`
		Description string `json:"description"`
		LivePlayURL string `json:"livePlayUrl,omitempty"`
	}{
		RoomSnapshotData: snap,
		ProductID:        a.ProductID,
		ProductName:      prod.Name,
		ImageURL:         prod.ImageURL,
		Description:      prod.Description,
		LivePlayURL:      livePlayURL,
	})
}

// GET /api/auctions -> recent auctions (newest first), joined to product name +
// image. Backs the seller 商品管理 table, the buyer browse list, and 历史竞拍记录.
// Money is a string at the JS boundary (P1). Optional ?limit=N.
func (s *Server) handleListAuctions(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, _ = strconv.Atoi(v)
	}
	items, err := s.st.ListAuctions(r.Context(), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	type dto struct {
		AuctionID         string `json:"auctionId"`
		ProductName       string `json:"productName"`
		ImageURL          string `json:"imageUrl"`
		Status            string `json:"status"`
		CurrentPriceCents string `json:"currentPriceCents"`
		WinnerID          string `json:"winnerId"`
		EndAtMs           int64  `json:"endAtMs"`
		CreatedAtMs       int64  `json:"createdAtMs"`
		Mode              string `json:"mode"`
		ParentAuctionID   string `json:"parentAuctionId,omitempty"`
		// 商品管理 table columns (起拍价/固定加价/封顶价/出价次数). Money as
		// string at the JS boundary (P1); bidCount is a plain counter.
		StartPriceCents string `json:"startPriceCents"`
		IncrementCents  string `json:"incrementCents"`
		CapPriceCents   string `json:"capPriceCents"`
		BidCount        int64  `json:"bidCount"`
	}
	out := make([]dto, 0, len(items))
	for _, it := range items {
		out = append(out, dto{
			AuctionID:         it.ID,
			ProductName:       it.ProductName,
			ImageURL:          it.ImageURL,
			Status:            it.Status,
			CurrentPriceCents: strconv.FormatInt(it.CurrentPriceCents, 10),
			WinnerID:          it.WinnerID,
			EndAtMs:           it.EndAtMs,
			CreatedAtMs:       it.CreatedAtMs,
			Mode:              model.NormalizeMode(it.Mode),
			ParentAuctionID:   it.ParentAuctionID,
			StartPriceCents:   strconv.FormatInt(it.StartPriceCents, 10),
			IncrementCents:    strconv.FormatInt(it.IncrementCents, 10),
			CapPriceCents:     strconv.FormatInt(it.CapPriceCents, 10),
			BidCount:          it.BidCount,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"auctions": out})
}

// GET /api/auctions/{id}/order -> the settlement order (订单管理 成交详情 / 结果查看).
// The Order struct marshals money-as-string (model.Cents) per P1.
func (s *Server) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	o, err := s.st.GetOrder(r.Context(), r.PathValue("id"))
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "no order for this auction (not sold yet)")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, o)
}

// POST /api/auctions/{id}/pay -> 模拟支付流程: mark the order paid. Idempotent.
// Only the winning buyer can pay their own order.
func (s *Server) handlePayOrder(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	o, err := s.st.GetOrder(r.Context(), aid)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "no order to pay")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if o.BuyerID != userID {
		writeErr(w, http.StatusForbidden, "not your order")
		return
	}
	paid, err := s.st.PayOrder(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, paid)
}

// PATCH /api/auctions/{id} -> modify a pre-start auction's rules (商品管理:
// 修改未开始竞拍的规则). Owner-only; allowed only while DRAFT/SCHEDULED.
func (s *Server) handlePatchAuction(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	a, ok := s.ownsAuction(w, r, aid, userID)
	if !ok {
		return
	}
	if a.Status != model.StateDraft && a.Status != model.StateScheduled {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "ERR_NOT_EDITABLE",
			"message": "rules can only be edited before the auction starts (DRAFT/SCHEDULED)",
		})
		return
	}
	// Partial merge: start from the current rules and overlay only the fields the
	// client sent, so a UI that edits just (e.g.) the start price doesn't have to
	// resend durationSec/extendSec it never sees in the snapshot.
	rules, err := s.st.GetRules(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "rules not found")
		return
	}
	var body struct {
		Rules json.RawMessage `json:"rules"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Rules) > 0 {
		if err := json.Unmarshal(body.Rules, &rules); err != nil {
			writeErr(w, http.StatusBadRequest, "bad rules: "+err.Error())
			return
		}
	}
	if err := s.st.UpdateRules(r.Context(), aid, rules); err != nil {
		if err == store.ErrNotFound {
			writeErr(w, http.StatusNotFound, "rules not found")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": "OK_RULES_UPDATED"})
}

// POST /api/auctions/{id}/freeze -> freeze_rules.lua (DRAFT -> SCHEDULED).
func (s *Server) handleFreeze(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		FactsConfirmed bool            `json:"factsConfirmed"`
		ConfirmedFacts json.RawMessage `json:"confirmedFacts"`
	}
	if err := readJSONOptional(r, &body); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	aid := r.PathValue("id")
	a, ok := s.ownsAuction(w, r, aid, userID)
	if !ok {
		return
	}
	// §spec: seller must confirm AI facts before the auction can be frozen/started.
	if !a.FactsConfirmed {
		writeJSON(w, http.StatusConflict, map[string]string{"code": model.CodeErrFacts})
		return
	}
	rules, err := s.st.GetRules(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "rules not found")
		return
	}
	var code string
	err = s.st.WithAuctionTransitionLock(r.Context(), aid, func() error {
		cur, err := s.st.GetAuction(r.Context(), aid)
		if err != nil {
			return err
		}
		if cur.SellerID != userID {
			code = model.CodeErrNotAllow
			return nil
		}
		if model.IsTerminal(cur.Status) {
			code = model.CodeErrAlreadyTerminal
			return nil
		}
		if cur.Status != model.StateDraft {
			code = model.CodeErrBadState
			return nil
		}
		if !cur.FactsConfirmed {
			code = model.CodeErrFacts
			return nil
		}
		if confirmedFacts := strings.TrimSpace(string(body.ConfirmedFacts)); confirmedFacts != "" && confirmedFacts != "null" {
			if err := s.st.UpdateConfirmedFacts(r.Context(), aid, confirmedFacts); err != nil {
				return err
			}
		}
		code, err = s.st.FreezeRules(r.Context(), aid, cur.SellerID, rules)
		if err != nil || code != model.CodeOKFrozen {
			return err
		}
		return s.st.UpdateAuctionStatus(r.Context(), aid, model.StateScheduled)
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if code != model.CodeOKFrozen {
		writeJSON(w, http.StatusConflict, map[string]any{"code": code})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code})
}

// POST /api/auctions/{id}/start {durationMs?} -> start_auction.lua (SCHEDULED -> LIVE).
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	if _, ok := s.ownsAuction(w, r, aid, userID); !ok {
		return
	}
	var body struct {
		DurationMs int64 `json:"durationMs"`
	}
	// body is optional (empty -> default duration), but a present-yet-malformed
	// body is a client error rather than a silent default.
	if err := readJSONOptional(r, &body); err != nil && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if body.DurationMs <= 0 {
		if rules, err := s.st.GetRules(r.Context(), aid); err == nil && rules.DurationSec > 0 {
			body.DurationMs = rules.DurationSec * 1000
		} else {
			body.DurationMs = 60_000
		}
	}
	code, endAtMs, err := s.st.StartAuction(r.Context(), aid, body.DurationMs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if code != model.CodeOKLive {
		writeJSON(w, http.StatusConflict, map[string]any{"code": code})
		return
	}
	if err := s.st.UpdateAuctionStatus(r.Context(), aid, model.StateLive); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// T7 §4.2: fire the `open` auctioneer trigger. Fire-and-forget — the
	// goroutine inside OnAuctionStart returns immediately, so we don't
	// block the seller's startLive response on the LLM call. Bid path
	// is never affected (V9 P3 invariant).
	if s.auctioneer != nil {
		startCents := ""
		if rules, err := s.st.GetRules(r.Context(), aid); err == nil {
			startCents = strconv.FormatInt(int64(rules.StartPriceCents), 10)
		}
		s.auctioneer.OnAuctionStart(r.Context(), aid, OpenContext{
			StartPriceCents: startCents,
			EndAtMs:         endAtMs,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "endAtMs": endAtMs})
}

// POST /api/auctions/{id}/cancel -> CANCELLED. §8: seller-only (ownsAuction).
// DRAFT (unfrozen, no Redis state/room) is a MySQL-only status flip; SCHEDULED/LIVE
// go through cancel_auction.lua (Redis transition + AUCTION_CANCELLED event, which
// the persistence worker projects to auctions.status — set synchronously here too
// for immediate REST consistency).
func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	a, ok := s.ownsAuction(w, r, aid, userID)
	if !ok {
		return
	}
	if model.IsTerminal(a.Status) {
		writeJSON(w, http.StatusConflict, map[string]any{"code": model.CodeErrAlreadyTerminal})
		return
	}
	if a.Status == model.StateDraft {
		var localCode string
		var localHTTP int
		useLuaCancel := false
		err := s.st.WithAuctionTransitionLock(r.Context(), aid, func() error {
			cur, err := s.st.GetAuction(r.Context(), aid)
			if err != nil {
				return err
			}
			if cur.SellerID != userID {
				localHTTP, localCode = http.StatusForbidden, model.CodeErrNotAllow
				return nil
			}
			if model.IsTerminal(cur.Status) {
				localHTTP, localCode = http.StatusConflict, model.CodeErrAlreadyTerminal
				return nil
			}
			if cur.Status != model.StateDraft {
				useLuaCancel = true
				return nil
			}
			// Freeze writes Redis before projecting MySQL to SCHEDULED. If cancel sees
			// MySQL=DRAFT during that window, a MySQL-only cancel would split the state.
			// Treat any existing Redis state as frozen and use cancel_auction.lua.
			snap, err := s.st.Snapshot(r.Context(), aid)
			if err != nil {
				return err
			}
			if snap.Status != "" {
				useLuaCancel = true
				return nil
			}
			ok, err := s.st.UpdateAuctionStatusIf(r.Context(), aid, model.StateCancelled, model.StateDraft)
			if err != nil {
				return err
			}
			if ok {
				localHTTP, localCode = http.StatusOK, model.CodeOKCancelled
				return nil
			}
			useLuaCancel = true
			return nil
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if localCode != "" {
			writeJSON(w, localHTTP, map[string]any{"code": localCode})
			return
		}
		if !useLuaCancel {
			return
		}
		// falls through to cancel_auction.lua below (now SCHEDULED/LIVE in Redis).
	}
	code, err := s.st.CancelAuction(r.Context(), aid, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if code != model.CodeOKCancelled {
		writeJSON(w, http.StatusConflict, map[string]any{"code": code})
		return
	}
	// drop from the Timer index; on failure the Timer self-heals (next scan finds
	// it, CloseAuction returns ERR_ALREADY_TERMINAL, and it untracks then).
	if err := s.st.UntrackActive(r.Context(), aid); err != nil {
		log.Printf("cancel %s: untrack active failed (timer will self-heal): %v", aid, err)
	}
	// MySQL status is a projection, not the source of truth: cancel_auction.lua has
	// already committed CANCELLED to Redis + the AUCTION_CANCELLED event to the Stream
	// (the canonical log), so the persistence worker's Stream-first sweep will set
	// auctions.status=CANCELLED even if this synchronous write fails. Log and still
	// return 200 — the cancel succeeded in the authoritative store; a 500 here would
	// report failure for a committed cancel that cannot be cleanly retried (a retry
	// hits ERR_ALREADY_TERMINAL). Eventual consistency is pinned by
	// TestT3CancelEventualConsistencyFromStream (TC-T3-101). (Contrast the DRAFT path
	// above, which has no Redis/Stream commit, so its MySQL write IS the operation and
	// still 500s on failure.)
	if err := s.st.UpdateAuctionStatus(r.Context(), aid, model.StateCancelled); err != nil {
		log.Printf("cancel %s: status projection write failed (persistence worker self-heals from Stream): %v", aid, err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code})
}

// GET /api/auctions/{id}/events-count -> {count} (MySQL projection; for e2e/verify).
func (s *Server) handleEventsCount(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.CountEvents(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": n})
}

// clampLeaderboardN parses the ?n= leaderboard size, clamping to [1,100] and
// defaulting to 10 for missing/invalid input (lenient query param — a bad n is
// not worth a 400; the cap bounds the Redis ZREVRANGE).
func clampLeaderboardN(q string) int {
	if q == "" {
		return 10
	}
	v, err := strconv.Atoi(q)
	if err != nil || v <= 0 {
		return 10
	}
	if v > 100 {
		return 100
	}
	return v
}

// GET /api/auctions/{id}/leaderboard?n=10 -> {auctionId, leaderboard:[{userId, amountCents}]}.
// Top-n bidders by accepted max amount (Redis ZSET), money as string. n clamps to [1,100].
// Requires a valid token: the bidder list (userId + amount) is room-scoped data, not
// public the way the single current price is — so unlike GET /auctions/{id} it is gated.
func (s *Server) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	lb, err := s.st.Leaderboard(r.Context(), aid, clampLeaderboardN(r.URL.Query().Get("n")))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Stamp the response with the auction's current state seq so the client can
	// reconcile by seq: it merge-MAXes the REST rows into its live board and never
	// lets a late/stale REST response regress a row a ROOM_STATE_PATCH already
	// advanced (跨端排名一致). Advisory — read via the (single-flighted) Snapshot;
	// the tiny race vs the ZREVRANGE is harmless because the client uses seq only
	// to order REST applies, never as authoritative leaderboard data.
	var seq int64
	if snap, serr := s.st.Snapshot(r.Context(), aid); serr == nil {
		seq = snap.Seq
	}
	writeJSON(w, http.StatusOK, map[string]any{"auctionId": aid, "leaderboard": lb, "seq": seq})
}

// GET /api/auctions/{id}/evidence -> T4 evidence card v0: authenticated access to
// the hash-chained event timeline, chain head (eventsHash), recompute-verified flag,
// and order (if the auction sold). Per proto/evidence-card.md; integrity check, not
// external notary (HMAC key custody = §6).
func (s *Server) handleEvidence(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	a, err := s.st.GetAuction(r.Context(), aid)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "auction not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	timeline, err := s.st.EventTimeline(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if timeline == nil {
		timeline = []store.EvidenceEvent{}
	}
	verified, breakAtSeq, err := s.st.VerifyEvidenceChain(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	chainHead := "" // published per §6 so a verifier can pin the tip
	if n := len(timeline); n > 0 {
		chainHead = timeline[n-1].EventHash
	}
	rules, rulesErr := s.st.GetRules(r.Context(), aid)
	order, orderErr := s.st.GetOrder(r.Context(), aid)
	summary := evidenceSummary(a.Status, timeline, order, orderErr == nil)
	resp := map[string]any{
		"auctionId":         aid,
		"status":            summary.Status,
		"currentPriceCents": summary.CurrentPriceCents,
		"winnerId":          summary.WinnerID,
		"seq":               summary.Seq,
		"eventsCount":       len(timeline),
		"factsConfirmed":    a.FactsConfirmed,
		"timeline":          timeline,
		"eventsHash":        chainHead, // chain head; "" for an empty chain
		"chainVerified":     verified,
		"note":              "T4 evidence v0: hash-chained integrity check (not external notarization; HMAC key custody per proto/evidence-card.md §6)",
	}
	if !verified {
		resp["hashBreakAtSeq"] = breakAtSeq
	}
	if rulesErr == nil && model.NormalizeMode(rules.Mode) == model.ModeAllPay {
		resp["settlement"] = model.SettlementVirtualCoinsOnly
	}
	if orderErr == nil {
		resp["order"] = order
	}
	writeJSON(w, http.StatusOK, resp)
}

type evidenceSummaryData struct {
	Status            string
	CurrentPriceCents string
	WinnerID          string
	Seq               int64
}

func evidenceSummary(mysqlStatus string, timeline []store.EvidenceEvent, order store.Order, hasOrder bool) evidenceSummaryData {
	out := evidenceSummaryData{Status: mysqlStatus}
	for _, e := range timeline {
		if e.Seq > out.Seq {
			out.Seq = e.Seq
		}
		switch e.EventType {
		case model.TypeBidAccepted:
			var p model.BidAcceptedData
			if json.Unmarshal(e.Payload, &p) == nil {
				out.CurrentPriceCents = p.AmountCents
				if p.UserID != "" {
					out.WinnerID = p.UserID
				}
			}
		case model.TypeAuctionSold:
			var p model.AuctionSoldData
			if json.Unmarshal(e.Payload, &p) == nil {
				out.Status = p.Status
				out.CurrentPriceCents = p.AmountCents
				out.WinnerID = p.WinnerID
			}
		case model.TypeAuctionNoBid:
			out.Status = model.StateNoBid
		case model.TypeAuctionCancelled:
			// A cancelled auction has no winner and no sale (T3 TC-T3-013): clear the
			// last-bid winner/price so the evidence card can't be misread as a sale.
			// Consistent with NO_BID — only SOLD / ORDER_CREATED carry winner+price.
			// (Addresses @fariZzzz #45 TC-T4-111 finding.)
			out.Status = model.StateCancelled
			out.WinnerID = ""
			out.CurrentPriceCents = ""
		}
	}
	if hasOrder {
		out.Status = model.StateOrderCreated
		out.CurrentPriceCents = strconv.FormatInt(int64(order.AmountCents), 10)
		out.WinnerID = order.BuyerID
	}
	return out
}

// --- helpers ---

// ownsAuction enforces §8: seller actions verify server-side ownership; the
// client-supplied identity is never trusted. Returns the auction on success.
func (s *Server) ownsAuction(w http.ResponseWriter, r *http.Request, aid, userID string) (store.Auction, bool) {
	a, err := s.st.GetAuction(r.Context(), aid)
	if err == store.ErrNotFound {
		writeErr(w, http.StatusNotFound, "auction not found")
		return a, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return a, false
	}
	if a.SellerID != userID {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": model.CodeErrNotAllow})
		return a, false
	}
	return a, true
}

func (s *Server) authUser(r *http.Request) (string, bool) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		tok = r.URL.Query().Get("token")
	}
	userID, err := auth.Verify(s.cfg.JWTSecret, tok)
	if err != nil {
		return "", false
	}
	return userID, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return false
	}
	return true
}

func readJSONOptional(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "anon"
	}
	return b.String()
}
