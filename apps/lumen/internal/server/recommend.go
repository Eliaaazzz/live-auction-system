package server

// Auction-mode recommender (issue #114). A deterministic Go heuristic that
// suggests a mode to a seller given (a) the LIVE viewer count for the room (the
// gateway already tracks this — Hub.viewerCount) and (b) the product's
// value/category. The recommendation is non-authoritative: the seller still
// picks. AI-assisted variants can later proxy to the ai-sidecar behind a flag
// without changing this fallback (V9 P3: AI never blocks).

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// recommendReq is the request payload. Inputs are intentionally small so the
// caller can run the heuristic before publishing (when no viewers exist yet).
type recommendReq struct {
	AuctionID   string `json:"auctionId,omitempty"`   // optional; if set, viewerCount is taken from Hub
	ViewerCount int    `json:"viewerCount,omitempty"` // fallback if no auction yet
	ValueCents  string `json:"valueCents,omitempty"`  // money-as-string; e.g. start price
	Category    string `json:"category,omitempty"`    // free-form, e.g. "collectible", "everyday"
}

// recommendResp is the response. Alternatives lets the UI offer alternatives.
type recommendResp struct {
	RecommendedMode string   `json:"recommendedMode"`
	Rationale       string   `json:"rationale"`
	Alternatives    []string `json:"alternatives"`
}

// recommendMode is the pure heuristic — extracted from the handler so it is
// trivially testable and deterministic (no I/O, no time, no randomness).
//
//	high viewers + low value      → ENGLISH (countdown bidding drama)
//	low viewers  + low value      → SUDDEN_DEATH (no extension; quick close)
//	any         + high value
//	            + collectible/    → SEALED_FIRST or VICKREY (serious bidders;
//	             rare/audit         anti-snipe-proof; truthful-bidding for Vickrey)
//	any         + high value
//	            + non-collectible → ENGLISH (price discovery on commodity)
func recommendMode(viewerCount int, valueCents int64, category string) recommendResp {
	const highValue = 50_000_00 // 5,000,000 cents = $50,000.00 (premium collectibles threshold)
	const highViewers = 50
	collectible := isCollectibleCategory(category)
	switch {
	case valueCents >= highValue && collectible:
		// Vickrey for very high value + collectible (encourages true valuations);
		// SEALED_FIRST as the alternative when sellers want "highest pays".
		return recommendResp{
			RecommendedMode: model.ModeVickrey,
			Rationale:       fmt.Sprintf("High-value collectible (%d cents, %q). Sealed-bid 2nd-price encourages truthful bidding from serious buyers and removes sniping pressure.", valueCents, category),
			Alternatives:    []string{model.ModeSealedFirst, model.ModeEnglish},
		}
	case valueCents >= highValue:
		return recommendResp{
			RecommendedMode: model.ModeSealedFirst,
			Rationale:       fmt.Sprintf("High value (%d cents). Sealed-bid first-price hides amounts during LIVE (no sniping) and reveals at close — good for serious bidders on a thin pool.", valueCents),
			Alternatives:    []string{model.ModeVickrey, model.ModeEnglish},
		}
	case viewerCount >= highViewers:
		return recommendResp{
			RecommendedMode: model.ModeEnglish,
			Rationale:       fmt.Sprintf("Crowded room (%d viewers). Ascending English + anti-snipe runs the classic live-auction drama and gives every viewer a moment to bid.", viewerCount),
			Alternatives:    []string{model.ModeSuddenDeath, model.ModeSealedFirst},
		}
	default:
		return recommendResp{
			RecommendedMode: model.ModeSuddenDeath,
			Rationale:       fmt.Sprintf("Quiet room (%d viewers) and modest value. Sudden Death closes cleanly with no late extensions — quick, low-stakes auction.", viewerCount),
			Alternatives:    []string{model.ModeEnglish, model.ModeSealedFirst},
		}
	}
}

func isCollectibleCategory(c string) bool {
	switch c {
	case "collectible", "card", "trading-card", "pokemon", "sports-card", "rare", "luxury", "art":
		return true
	}
	return false
}

// POST /api/recommend-mode {auctionId?, viewerCount?, valueCents?, category?}
// -> {recommendedMode, rationale, alternatives}
// Auth-gated to match handleLeaderboard's posture (also uses an auctionId +
// touches Hub state) — without auth this would be a viewer-count oracle for any
// id (PR #117 review).
func (s *Server) handleRecommendMode(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body recommendReq
	if !readJSON(w, r, &body) {
		return
	}
	viewers := body.ViewerCount
	if body.AuctionID != "" && s.hub != nil {
		viewers = s.hub.viewerCount(body.AuctionID)
	}
	var valueCents int64
	if body.ValueCents != "" {
		// Money-as-string: parse defensively. Bad input → treat as 0 (the
		// recommender's fallback bucket handles it gracefully).
		if v, err := strconv.ParseInt(body.ValueCents, 10, 64); err == nil {
			valueCents = v
		}
	}
	resp := recommendMode(viewers, valueCents, body.Category)
	writeJSON(w, http.StatusOK, resp)
}
