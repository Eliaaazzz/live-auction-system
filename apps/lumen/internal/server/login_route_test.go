package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLoginAliasRoute(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{Timeout: 3 * time.Second}

	for _, path := range []string{"/api/login", "/api/dev-login"} {
		t.Run(path, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, target+path, strings.NewReader(`{"nickname":"router-tester","role":"user"}`))
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := hc.Do(req)
			if err != nil {
				t.Fatalf("do %s: %v", path, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s: got status %d", path, resp.StatusCode)
			}
			var out struct {
				Token string `json:"token"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatalf("%s decode: %v", path, err)
			}
			if out.Token == "" {
				t.Fatalf("%s: empty token", path)
			}
		})
	}
}
