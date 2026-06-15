// Package llm is a tiny OpenAI-compatible chat-completions client shared by the
// sidecar's VLM / auctioneer / advisor generators.
//
// It speaks the OpenAI POST {BaseURL}/chat/completions schema, so the SAME code
// drives any OpenAI-compatible server with nothing but env changes:
//   - Volcengine Ark (火山方舟 / 豆包 Doubao) — the hosted path for this
//     ByteDance Douyin challenge. BaseURL https://ark.cn-beijing.volces.com/api/v3,
//     Model = the inference endpoint id (ep-…) or a doubao-* model name.
//   - Ollama / vLLM — a SELF-HOSTED open-source model (Qwen2.5, Llama, …).
//     BaseURL http://host:11434/v1, Model qwen2.5:7b. This is the optional
//     「开源模型调用」 path; same adapter, different env.
//   - Any other OpenAI-compatible gateway (Groq, OpenAI, …).
//
// Non-authoritative by construction (V9 P3): every caller wraps Complete() in a
// guardrail + canned fallback (auctioneer.generateWithGuardrail, vlm mock,
// advisor.fallbackResponse). A missing key, timeout, rate-limit, or bad JSON
// degrades to deterministic text and NEVER blocks the bid path. Complete()
// returns ErrNotConfigured when no key/model is set, so a box without
// credentials transparently keeps running the mock generators.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultArkBaseURL is the Volcengine Ark OpenAI-compatible endpoint (Beijing).
// Ark is OpenAI-compatible at /api/v3/chat/completions.
const DefaultArkBaseURL = "https://ark.cn-beijing.volces.com/api/v3"

// ErrNotConfigured is returned by Complete when the config has no API key or no
// model — the signal for callers to fall back to their mock/canned generator.
var ErrNotConfigured = errors.New("llm: not configured (no API key / model)")

// Config points the adapter at one OpenAI-compatible endpoint.
type Config struct {
	BaseURL string
	APIKey  string
	Model   string
	Timeout time.Duration
	// Thinking gates Doubao's reasoning mode. "" → omit the field entirely (keeps
	// the request OpenAI-compatible for Ollama/vLLM/OpenAI). "disabled"/"enabled"/
	// "auto" → sent as {"thinking":{"type":…}} for Doubao Seed-1.6 reasoning models.
	// "disabled" makes Seed-1.6 ~10x faster (no reasoning tokens) — both callers are
	// advisory/off the bid path, so the latency win beats the marginal quality loss.
	Thinking string
}

// ConfigFromEnv reads {PREFIX}_BASE_URL / {PREFIX}_API_KEY / {PREFIX}_MODEL,
// applying the supplied defaults for base URL + model. The key has no default:
// absent key → Enabled()==false → callers stay on mock. This is why a fresh
// deploy with no credentials is safe.
func ConfigFromEnv(prefix, defBaseURL, defModel string) Config {
	return Config{
		BaseURL: envOr(prefix+"_BASE_URL", defBaseURL),
		APIKey:  strings.TrimSpace(os.Getenv(prefix + "_API_KEY")),
		Model:   envOr(prefix+"_MODEL", defModel),
		// 30s default: Doubao Seed-2.0 "thinking" models have high first-token
		// latency (an 8s budget timed out cross-region). Both callers are OFF the
		// bid hot path (auctioneer is dispatched async; VLM is a seller pre-freeze
		// action), so a generous budget is safe. Override per prefix with
		// {PREFIX}_TIMEOUT_MS (e.g. LLM_TIMEOUT_MS=12000 for a fast Lite model).
		Timeout: envDurationMs(prefix+"_TIMEOUT_MS", 30*time.Second),
		// {PREFIX}_THINKING=disabled turns OFF Seed-1.6 reasoning (≈10x faster).
		// Empty → field omitted (stays OpenAI-compatible for non-Doubao backends).
		Thinking: strings.TrimSpace(os.Getenv(prefix + "_THINKING")),
	}
}

// Enabled reports whether a real call can be made (key + model both present).
func (c Config) Enabled() bool {
	return strings.TrimSpace(c.APIKey) != "" && strings.TrimSpace(c.Model) != ""
}

// Message is one chat turn. Content is `any` so it can be a plain string OR the
// OpenAI multimodal content-parts array (text + image_url) for vision.
type Message struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// System / UserText build plain text turns.
func System(text string) Message    { return Message{Role: "system", Content: text} }
func UserText(text string) Message  { return Message{Role: "user", Content: text} }
func Assistant(text string) Message { return Message{Role: "assistant", Content: text} }

// UserWithImage builds a multimodal user turn (OpenAI vision shape). imageURL is
// usually a `data:image/...;base64,...` URL so the image bytes the sidecar
// already SSRF-fetched are sent inline (never a second server-side fetch).
func UserWithImage(text, imageURL string) Message {
	return Message{Role: "user", Content: []any{
		map[string]any{"type": "text", "text": text},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageURL}},
	}}
}

// Options tunes one completion. Zero values get sane defaults.
type Options struct {
	MaxTokens   int
	Temperature float64
}

// thinkingParam is Doubao's reasoning toggle; omitempty keeps it off the wire
// for non-Doubao OpenAI-compatible backends when Config.Thinking is "".
type thinkingParam struct {
	Type string `json:"type"`
}

type chatRequest struct {
	Model       string         `json:"model"`
	Messages    []Message      `json:"messages"`
	MaxTokens   int            `json:"max_tokens"`
	Temperature float64        `json:"temperature"`
	Thinking    *thinkingParam `json:"thinking,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Complete POSTs one chat completion and returns the assistant text. It is
// bounded by c.Timeout and never follows the bid path — callers fall back on
// any error. Returns ErrNotConfigured when the config is incomplete.
func (c Config) Complete(ctx context.Context, msgs []Message, opt Options) (string, error) {
	if !c.Enabled() {
		return "", ErrNotConfigured
	}
	maxTokens := opt.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 512
	}
	reqBody := chatRequest{
		Model:       c.Model,
		Messages:    msgs,
		MaxTokens:   maxTokens,
		Temperature: opt.Temperature,
	}
	if c.Thinking != "" {
		reqBody.Thinking = &thinkingParam{Type: c.Thinking}
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	url := strings.TrimRight(c.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	// Cap the read: a hostile/buggy gateway can't OOM the sidecar.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		snippet := string(body)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return "", fmt.Errorf("llm: status %d: %s", resp.StatusCode, snippet)
	}

	var out chatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("llm: decode response: %w", err)
	}
	if out.Error != nil && out.Error.Message != "" {
		return "", fmt.Errorf("llm: api error: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", errors.New("llm: empty choices")
	}
	text := strings.TrimSpace(out.Choices[0].Message.Content)
	if text == "" {
		return "", errors.New("llm: empty completion")
	}
	return text, nil
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// envDurationMs reads an integer-millisecond env var, falling back to def.
func envDurationMs(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	ms, err := strconv.Atoi(v)
	if err != nil || ms <= 0 {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}
