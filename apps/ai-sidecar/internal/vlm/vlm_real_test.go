package vlm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestExtractJSONObject_StripsFencesAndProse(t *testing.T) {
	cases := map[string]string{
		"plain":  `{"facts":[]}`,
		"fenced": "```json\n{\"facts\":[]}\n```",
		"prose":  "Sure! Here is the JSON:\n{\"facts\":[]}\nHope that helps.",
	}
	for name, in := range cases {
		got := extractJSONObject(in)
		var probe map[string]any
		if err := json.Unmarshal([]byte(got), &probe); err != nil {
			t.Fatalf("%s: extractJSONObject did not yield valid JSON: %q", name, got)
		}
	}
	// No braces → returned unchanged (parseDoubao then surfaces the error).
	if got := extractJSONObject("no json here"); got != "no json here" {
		t.Fatalf("expected passthrough on no-brace input, got %q", got)
	}
}

func TestWithModelName_FillsWhenAbsentPreservesWhenPresent(t *testing.T) {
	// Absent → filled with the configured model.
	out := withModelName(`{"facts":[]}`, "ep-real-123")
	var a struct {
		ModelName string `json:"modelName"`
	}
	_ = json.Unmarshal([]byte(out), &a)
	if a.ModelName != "ep-real-123" {
		t.Fatalf("modelName not filled: %q", out)
	}
	// Present → preserved.
	out = withModelName(`{"facts":[],"modelName":"doubao-x"}`, "ep-real-123")
	_ = json.Unmarshal([]byte(out), &a)
	if a.ModelName != "doubao-x" {
		t.Fatalf("modelName should be preserved, got %q", a.ModelName)
	}
	// Unparseable → returned untouched (parseDoubao will error downstream).
	if got := withModelName("not json", "m"); got != "not json" {
		t.Fatalf("unparseable input must pass through, got %q", got)
	}
}

func TestImageDataURL_SniffsMimeAndBase64(t *testing.T) {
	// PNG magic header → image/png data URL, base64-encoded.
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01}
	url := imageDataURL(png)
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("expected png data URL, got %q", url[:32])
	}
}

// real-mode requested but model unset → canned facts (still demoable), never a
// nil/error. Confirms the "VLM_MODE=real without full Ark config" safety path.
func TestCallDoubao_IncompleteConfigReturnsCanned(t *testing.T) {
	t.Setenv("VLM_BASE_URL", "")
	t.Setenv("VLM_API_KEY", "")
	t.Setenv("VLM_MODEL", "")
	raw, err := callDoubao(context.Background(), "", "prompt", []byte("imgbytes"))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := parseDoubao(raw)
	if err != nil {
		t.Fatal(err)
	}
	if resp.ModelName != "doubao-vlm-stub" {
		t.Fatalf("expected canned stub modelName, got %q", resp.ModelName)
	}
}
