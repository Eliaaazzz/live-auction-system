package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
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
	id := "auc_" + newID()
	if err := s.st.CreateAuction(r.Context(), id, body.ProductID, userID, body.Rules, body.FactsConfirmed, string(body.ConfirmedFacts)); err != nil {
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
	writeJSON(w, http.StatusOK, snap)
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
	code, err := s.st.FreezeRules(r.Context(), aid, rules)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if code != model.CodeOKFrozen {
		writeJSON(w, http.StatusConflict, map[string]any{"code": code})
		return
	}
	_ = s.st.UpdateAuctionStatus(r.Context(), aid, model.StateScheduled)
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
	_ = s.st.UpdateAuctionStatus(r.Context(), aid, model.StateLive)
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "endAtMs": endAtMs})
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

// GET /api/auctions/{id}/evidence -> T1 evidence stub (real hash chain = T4).
func (s *Server) handleEvidence(w http.ResponseWriter, r *http.Request) {
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
	snap, _ := s.st.Snapshot(r.Context(), aid)
	status := snap.Status
	if status == "" {
		status = a.Status
	}
	n, _ := s.st.CountEvents(r.Context(), aid)
	writeJSON(w, http.StatusOK, map[string]any{
		"auctionId":         aid,
		"status":            status,
		"currentPriceCents": snap.CurrentPriceCents,
		"winnerId":          snap.WinnerID,
		"seq":               snap.Seq,
		"eventsCount":       n,
		"factsConfirmed":    a.FactsConfirmed,
		"eventsHash":        nil, // hash chain is computed by the Persistence Worker in T4
		"note":              "T1 evidence stub; events_hash chain lands in T4",
	})
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
