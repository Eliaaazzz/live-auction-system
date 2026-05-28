package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
	if err := body.Rules.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	id := "auc_" + newID()
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
	if snap.Rules == nil {
		rules, err := s.st.GetRules(r.Context(), aid)
		if err != nil {
			if err == store.ErrNotFound {
				writeErr(w, http.StatusNotFound, "rules not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		dto := rules.RoomSnapshotRules()
		snap.Rules = &dto
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
	}{
		RoomSnapshotData: snap,
		ProductID:        a.ProductID,
		ProductName:      prod.Name,
		ImageURL:         prod.ImageURL,
		Description:      prod.Description,
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

// POST /api/auctions/{id}/freeze -> freeze_rules.lua (DRAFT -> SCHEDULED).
func (s *Server) handleFreeze(w http.ResponseWriter, r *http.Request) {
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
	writeJSON(w, http.StatusOK, map[string]any{"auctionId": aid, "leaderboard": lb})
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
	verified, breakAtSeq, err := s.st.VerifyEvidenceChain(r.Context(), aid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	chainHead := "" // published per §6 so a verifier can pin the tip
	if n := len(timeline); n > 0 {
		chainHead = timeline[n-1].EventHash
	}
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
