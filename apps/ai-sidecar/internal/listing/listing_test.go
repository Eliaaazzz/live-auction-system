package listing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/ai-sidecar/internal/llm"
)

func TestMockGenerator_InputAwareAndCompliant(t *testing.T) {
	resp := draftWithGuardrail(Request{Title: "劳力士 Explorer 114270", Category: "腕表"}, MockGenerator)
	if resp.Title == "" || len(resp.SellingPoints) == 0 || resp.Script == "" {
		t.Fatalf("mock must return complete copy: %+v", resp)
	}
	if resp.Disclaimer == "" {
		t.Fatal("disclaimer must always be present")
	}
	if _, bad := draftFailsGuardrail(Draft{Title: resp.Title, SellingPoints: resp.SellingPoints, Script: resp.Script}); bad {
		t.Fatal("mock output must itself pass the guardrail")
	}
}

func TestMockGenerator_DropsToxicSellerInput(t *testing.T) {
	resp := draftWithGuardrail(Request{
		Title:    "百分百正品保真腕表 联系电话13800138000",
		Category: "绝对最低价 ¥999",
	}, MockGenerator)
	if _, bad := draftFailsGuardrail(Draft{Title: resp.Title, SellingPoints: resp.SellingPoints, Script: resp.Script}); bad {
		t.Fatalf("mock/no-creds path must not leak toxic seller input: %+v", resp)
	}
	for _, bad := range []string{"百分百正品", "保真", "绝对最低价", "13800138000", "¥999"} {
		if strings.Contains(resp.Title, bad) || strings.Contains(resp.Script, bad) || anyPointContains(resp.SellingPoints, bad) {
			t.Fatalf("mock output leaked %q from seller input: %+v", bad, resp)
		}
	}
}

func TestHandlerFunc_400OnMalformedBody(t *testing.T) {
	req := httptest.NewRequest("POST", "/llm/listing", strings.NewReader("not json"))
	rr := httptest.NewRecorder()
	HandlerFunc(MockGenerator).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rr.Code)
	}
}

func TestHandlerFunc_AlwaysReturnsUsableCopy(t *testing.T) {
	// A generator that errors → handler still returns complete canned copy.
	failing := func(Request) (Draft, error) { return Draft{}, errAlways }
	body, _ := json.Marshal(Request{Title: "青花瓷瓶", Category: "瓷器"})
	req := httptest.NewRequest("POST", "/llm/listing", strings.NewReader(string(body)))
	rr := httptest.NewRecorder()
	HandlerFunc(failing).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var resp Response
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if !resp.Fallback || resp.Title == "" || len(resp.SellingPoints) == 0 {
		t.Fatalf("error path must yield complete canned copy with Fallback=true: %+v", resp)
	}
}

func TestFallbackResponse_DropsToxicSellerInputOnGeneratorError(t *testing.T) {
	failing := func(Request) (Draft, error) { return Draft{}, errAlways }
	resp := draftWithGuardrail(Request{
		Title:    "保真名表 www.bad.example 联系电话13800138000",
		Category: "绝对最低价 元999",
	}, failing)
	if !resp.Fallback {
		t.Fatal("generator error must return fallback copy")
	}
	if _, bad := draftFailsGuardrail(Draft{Title: resp.Title, SellingPoints: resp.SellingPoints, Script: resp.Script}); bad {
		t.Fatalf("fallback copy must pass guardrail even with toxic input: %+v", resp)
	}
	for _, bad := range []string{"保真", "www.bad.example", "13800138000", "绝对最低价", "元999"} {
		if strings.Contains(resp.Title, bad) || strings.Contains(resp.Script, bad) || anyPointContains(resp.SellingPoints, bad) {
			t.Fatalf("fallback output leaked %q from seller input: %+v", bad, resp)
		}
	}
}

var errAlways = &genError{}

type genError struct{}

func (*genError) Error() string { return "boom" }

func TestArkGenerator_RoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// model replies with fenced JSON + prose → extractJSONObject must cope
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"好的：\n{\"title\":\"黑面 Explorer 腕表\",\"sellingPoints\":[\"经典运动款\",\"成色良好\",\"卖家已实名\"],\"script\":\"各位买家，这枚腕表现在开拍，欢迎理性出价。\"}"}}]}`))
	}))
	defer srv.Close()

	gen := arkGenerator(llm.Config{BaseURL: srv.URL, APIKey: "k", Model: "ep-test"})
	resp := draftWithGuardrail(Request{Title: "Explorer", Category: "腕表"}, gen)
	if resp.Fallback {
		t.Fatalf("clean model output must not fall back: %+v", resp)
	}
	if resp.Title != "黑面 Explorer 腕表" || len(resp.SellingPoints) != 3 {
		t.Fatalf("model draft not parsed: %+v", resp)
	}
}

func TestGuardrail_RejectsNonCompliantModelOutput(t *testing.T) {
	// model returns a 保真/绝对 claim → guardrail swaps to canned fallback.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"百分百正品保真腕表\",\"sellingPoints\":[\"绝对最低价\"],\"script\":\"假一赔十，全网最低！\"}"}}]}`))
	}))
	defer srv.Close()

	gen := arkGenerator(llm.Config{BaseURL: srv.URL, APIKey: "k", Model: "ep-test"})
	resp := draftWithGuardrail(Request{Title: "腕表", Category: "腕表"}, gen)
	if !resp.Fallback {
		t.Fatal("non-compliant copy (保真/绝对/最低价/假一赔十) must trip the guardrail")
	}
}

func TestSelect_NoCredsKeepsMock(t *testing.T) {
	t.Setenv("LLM_API_KEY", "")
	t.Setenv("LLM_MODEL", "")
	resp := draftWithGuardrail(Request{Title: "测试", Category: "其他"}, Select())
	if resp.ModelName != mockModelName {
		t.Fatalf("no creds must keep mock, got modelName=%q", resp.ModelName)
	}
}

func TestSelect_CredsResetModelLabel(t *testing.T) {
	t.Setenv("LLM_API_KEY", "k")
	t.Setenv("LLM_MODEL", "ep-real")
	_ = Select()
	if activeModel != "ep-real" {
		t.Fatalf("activeModel=%q want ep-real", activeModel)
	}
	// reset for isolation: no creds must restore the mock label
	t.Setenv("LLM_API_KEY", "")
	t.Setenv("LLM_MODEL", "")
	resp := draftWithGuardrail(Request{Title: "x", Category: "y"}, Select())
	if resp.ModelName != mockModelName {
		t.Fatalf("ModelName=%q want %q after no-creds Select", resp.ModelName, mockModelName)
	}
}

func TestNormalize_CapsPointsAndTrims(t *testing.T) {
	d := normalize(Draft{
		Title:         "  标题  ",
		SellingPoints: []string{" a ", "", "b", "c", "d", "e", "f"},
		Script:        " 话术 ",
	})
	if d.Title != "标题" || d.Script != "话术" {
		t.Fatalf("trim failed: %+v", d)
	}
	if len(d.SellingPoints) != maxPoints {
		t.Fatalf("points not capped to %d: %v", maxPoints, d.SellingPoints)
	}
}

func anyPointContains(points []string, needle string) bool {
	for _, p := range points {
		if strings.Contains(p, needle) {
			return true
		}
	}
	return false
}
