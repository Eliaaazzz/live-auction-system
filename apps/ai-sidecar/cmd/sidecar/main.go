// Command sidecar is the Lumen AI sidecar. T1 ships a MOCK: it returns canned
// VLM facts in the proto/ai-events.md shape so the demo path is complete without
// a live model. Real Doubao + 4 triggers + streaming + SSRF allowlist = T7. The
// sidecar is a separate process so chaos drills (T9) can kill it independently.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/advisor"
	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/auctioneer"
	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/vlm"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})
	// T7 §4.1: VLM facts draft. vlm.Select() picks the real Doubao path
	// when VLM_MODE=real (image fetch SSRF-guarded; seller text treated
	// as untrusted data), else the canned mock. 502 on generator error →
	// backend proxy maps to ERR_AI_UNAVAILABLE; bidding is never blocked.
	mux.HandleFunc("POST /facts/draft", vlm.HandlerFunc(vlm.Select()))
	// T7 §4.2: LLM auctioneer 4-trigger endpoint. Mock generator returns
	// canned-but-trigger-aware commentary in T1/T7 mock; real Doubao swap
	// is a follow-up. Guardrail (length/URL/phone/money/banned-word) runs
	// regardless of generator. See proto/ai-events.md §POST /llm/auctioneer.
	mux.HandleFunc("POST /llm/auctioneer", auctioneer.HandlerFunc(auctioneer.MockGenerator))
	// #111 (advisory, non-adjudicating): pricing / mode recommendation for the
	// seller BEFORE freeze. advisoryOnly=true + disclaimer always; never writes
	// auction state, bid path never waits on it. SEALED state + reserve
	// adjudication are OUT of scope here (ratify-gated). See
	// proto/ai-events.md §POST /llm/recommend.
	mux.HandleFunc("POST /llm/recommend", advisor.HandlerFunc(advisor.MockGenerator))

	addr := os.Getenv("SIDECAR_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	mode := os.Getenv("VLM_MODE")
	if mode == "" {
		mode = "mock"
	}
	log.Printf("ai-sidecar listening on %s (vlm=%s)", addr, mode)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
