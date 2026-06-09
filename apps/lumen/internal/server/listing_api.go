package server

import (
	"io"
	"net/http"
	"strings"
)

// POST /api/listing/draft -> proxied to ai-sidecar /llm/listing.
// Drafts AI auction copy (title / selling points / opening script) that the
// seller edits before publishing. Auth-gated like facts/draft. Advisory only:
// no auction state is written here, and the bid/settlement path never calls it.
func (s *Server) handleListingDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.cfg.AISidecarURL+"/llm/listing", strings.NewReader(string(body)))
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
