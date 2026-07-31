package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A real round-trip against an httptest server standing in for Ark/Ollama:
// asserts the request shape (path, bearer, model, messages) and that the
// assistant content is returned.
func TestComplete_RoundTrip(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"  Bidding is open - get your bids ready. "}}]}`))
	}))
	defer srv.Close()

	cfg := Config{BaseURL: srv.URL, APIKey: "k-test", Model: "doubao-test"}
	out, err := cfg.Complete(context.Background(), []Message{
		System("you are an auctioneer"),
		UserText("trigger=open"),
	}, Options{MaxTokens: 64, Temperature: 0.5})
	if err != nil {
		t.Fatal(err)
	}
	if out != "Bidding is open - get your bids ready." {
		t.Fatalf("content not trimmed/returned: %q", out)
	}
	if gotAuth != "Bearer k-test" {
		t.Fatalf("bearer not set: %q", gotAuth)
	}
	if !strings.HasSuffix(gotPath, "/chat/completions") {
		t.Fatalf("wrong path: %q", gotPath)
	}
	if gotBody.Model != "doubao-test" || gotBody.MaxTokens != 64 || len(gotBody.Messages) != 2 {
		t.Fatalf("request body wrong: %+v", gotBody)
	}
}

func TestComplete_NotConfigured(t *testing.T) {
	// No key → ErrNotConfigured (callers fall back to mock). No network touched.
	if _, err := (Config{Model: "m"}).Complete(context.Background(), nil, Options{}); err != ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
	if _, err := (Config{APIKey: "k"}).Complete(context.Background(), nil, Options{}); err != ErrNotConfigured {
		t.Fatalf("no model must also be ErrNotConfigured, got %v", err)
	}
}

func TestComplete_Non200IsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "k", Model: "m"}
	if _, err := cfg.Complete(context.Background(), []Message{UserText("hi")}, Options{}); err == nil {
		t.Fatal("expected error on 429")
	}
}

func TestComplete_EmptyChoicesIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()
	cfg := Config{BaseURL: srv.URL, APIKey: "k", Model: "m"}
	if _, err := cfg.Complete(context.Background(), []Message{UserText("hi")}, Options{}); err == nil {
		t.Fatal("expected error on empty choices")
	}
}

// The vision turn must marshal into the OpenAI content-parts array so Ark
// doubao-vision (and any OpenAI-compatible VLM) receives the image.
func TestUserWithImage_MarshalsContentParts(t *testing.T) {
	msg := UserWithImage("describe", "data:image/jpeg;base64,AAAA")
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	for _, want := range []string{`"role":"user"`, `"type":"text"`, `"type":"image_url"`, `data:image/jpeg;base64,AAAA`} {
		if !strings.Contains(s, want) {
			t.Fatalf("vision message missing %q in %s", want, s)
		}
	}
}

func TestConfigFromEnv_KeyGatesEnabled(t *testing.T) {
	t.Setenv("LLM_BASE_URL", "")
	t.Setenv("LLM_API_KEY", "")
	t.Setenv("LLM_MODEL", "")
	cfg := ConfigFromEnv("LLM", DefaultArkBaseURL, "")
	if cfg.BaseURL != DefaultArkBaseURL {
		t.Fatalf("default base url not applied: %q", cfg.BaseURL)
	}
	if cfg.Enabled() {
		t.Fatal("no key/model must be disabled (stay on mock)")
	}
	t.Setenv("LLM_API_KEY", "k")
	t.Setenv("LLM_MODEL", "ep-123")
	if !ConfigFromEnv("LLM", DefaultArkBaseURL, "").Enabled() {
		t.Fatal("key+model present must enable the real path")
	}
}
