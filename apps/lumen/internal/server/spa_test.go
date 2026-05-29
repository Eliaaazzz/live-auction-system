package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// spaFileServer must serve real files as-is but fall back to index.html for
// unknown paths, so the React app's BrowserRouter deep links (/room/:id) resolve
// on direct load / refresh. Pins the behavior the live stack depends on.
func TestSPAFileServer(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("INDEX_HTML"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("JS_BUNDLE"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(spaFileServer(dir))
	defer srv.Close()

	cases := []struct {
		name, path, wantBody string
	}{
		{"root serves index", "/", "INDEX_HTML"},
		{"existing asset served as-is", "/assets/app.js", "JS_BUNDLE"},
		{"unknown SPA route falls back to index", "/room/auc_demo", "INDEX_HTML"},
		{"deep unknown route falls back to index", "/evidence/auc_x/foo", "INDEX_HTML"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, err := http.Get(srv.URL + c.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			buf := make([]byte, len(c.wantBody))
			n, _ := resp.Body.Read(buf)
			if got := string(buf[:n]); got != c.wantBody {
				t.Errorf("%s -> body %q, want %q (status %d)", c.path, got, c.wantBody, resp.StatusCode)
			}
		})
	}
}
