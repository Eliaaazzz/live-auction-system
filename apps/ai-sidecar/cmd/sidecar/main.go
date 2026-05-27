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

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/auctioneer"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /facts/draft", factsDraft)
	// T7 §4.2: LLM auctioneer 4-trigger endpoint. Mock generator returns
	// canned-but-trigger-aware text in T1/T7 mock; real Doubao swap is a
	// follow-up. Guardrail (length/URL/phone/money/banned-word) runs
	// regardless of generator. See proto/ai-events.md §POST /auctioneer.
	mux.HandleFunc("POST /auctioneer", auctioneer.HandlerFunc(auctioneer.MockGenerator))

	addr := os.Getenv("SIDECAR_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	log.Printf("ai-sidecar (mock) listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func factsDraft(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"facts": []map[string]any{
			{"field": "category", "value": "watch", "confidence": 0.91, "highRisk": false},
			{"field": "authenticity", "value": "unverified", "confidence": 0.0, "highRisk": true},
		},
		"highRiskFieldsDisclaimer": "高风险字段为卖家声明，AI 未验证。",
		"modelName":                "mock-vlm-T1",
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
