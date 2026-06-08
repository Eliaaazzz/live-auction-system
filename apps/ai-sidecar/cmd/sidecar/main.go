// Command sidecar is the Lumen AI sidecar.
//
// All three endpoints select their generator by env at startup:
//   - VLM facts (/facts/draft) and auctioneer commentary (/llm/auctioneer) run a
//     REAL OpenAI-compatible model when credentials are set — Volcengine Ark /
//     豆包 Doubao by default (VLM_API_KEY+VLM_MODEL / LLM_API_KEY+LLM_MODEL), or
//     any OpenAI-compatible server (Ollama + Qwen2.5 for the open-source path)
//     by repointing *_BASE_URL/*_MODEL. With no creds they fall back to canned
//     generators, so a box without keys still serves a complete demo path.
//   - Pricing advice (/llm/recommend) uses a transparent deterministic heuristic
//     by design — explainable numbers, no hallucinated reserve prices.
//
// AI is non-authoritative (V9 P3): a guardrail + canned fallback wraps every
// generator, and the backend never blocks the bid path on this service — so a
// chaos drill (T9) can kill the sidecar independently with no correctness impact.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/advisor"
	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/auctioneer"
	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/listing"
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
	// LLM auctioneer 4-trigger endpoint. auctioneer.Select() picks the real
	// OpenAI-compatible model when LLM_API_KEY+LLM_MODEL are set, else the
	// canned-but-trigger-aware mock. Guardrail (length/URL/phone/money/
	// banned-word) runs regardless of generator. See proto/ai-events.md.
	mux.HandleFunc("POST /llm/auctioneer", auctioneer.HandlerFunc(auctioneer.Select()))
	// #111 (advisory, non-adjudicating): pricing / mode recommendation for the
	// seller BEFORE freeze. advisoryOnly=true + disclaimer always; never writes
	// auction state, bid path never waits on it. SEALED state + reserve
	// adjudication are OUT of scope here (ratify-gated). See
	// proto/ai-events.md §POST /llm/recommend.
	mux.HandleFunc("POST /llm/recommend", advisor.HandlerFunc(advisor.MockGenerator))
	// AI 拍卖文案: drafts a title + selling points + opening script from the
	// seller's product info. listing.Select() shares the auctioneer's LLM_*
	// creds (real Doubao when set, else canned). Compliance guardrail (no
	// 保真/绝对化/联系方式/编造事实) runs on every generator's output. The
	// seller edits before publishing — advisory only, never auto-applied.
	mux.HandleFunc("POST /llm/listing", listing.HandlerFunc(listing.Select()))

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
