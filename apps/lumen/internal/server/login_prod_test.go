package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
)

func TestPublicLoginAlwaysMintsUserRole(t *testing.T) {
	target, srv := startTestServer(t)
	hc := &http.Client{}

	body := []byte(`{"nickname":"Mallory Seller","role":"seller"}`)
	resp, err := hc.Post(target+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/api/login status=%d want 200", resp.StatusCode)
	}
	var out struct {
		UserID   string `json:"userId"`
		Token    string `json:"token"`
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.UserID == "" || out.Token == "" || out.Nickname != "Mallory Seller" {
		t.Fatalf("login response=%+v", out)
	}
	verifiedUserID, err := auth.Verify(srv.cfg.JWTSecret, out.Token)
	if err != nil {
		t.Fatalf("token verify: %v", err)
	}
	if verifiedUserID != out.UserID {
		t.Fatalf("token user=%s want %s", verifiedUserID, out.UserID)
	}
	var role string
	if err := srv.st.DB().QueryRowContext(context.Background(), "SELECT role FROM users WHERE id=?", out.UserID).Scan(&role); err != nil {
		t.Fatalf("query role: %v", err)
	}
	if role != "user" {
		t.Fatalf("public login stored role=%q want user", role)
	}
}

func TestPublicLoginRejectsBlankNickname(t *testing.T) {
	target, _ := startTestServer(t)
	hc := &http.Client{}
	resp, err := hc.Post(target+"/api/login", "application/json", bytes.NewReader([]byte(`{"nickname":"   "}`)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank nickname status=%d want 400", resp.StatusCode)
	}
}
