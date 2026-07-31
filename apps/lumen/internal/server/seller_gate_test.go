package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// #260-4: with LUMEN_SELLER_KEY configured, creation endpoints only accept the
// seller_* namespace, which only a key-checked login can mint. The plain login
// derives ids as user_+slug(nickname) — publicly impersonable — so the
// namespace, not a nickname-keyed role, is the trust boundary.

type loginResp struct {
	UserID   string `json:"userId"`
	Token    string `json:"token"`
	Nickname string `json:"nickname"`
	Role     string `json:"role"`
}

func postLogin(t *testing.T, target, body string) (*http.Response, loginResp) {
	t.Helper()
	resp, err := http.Post(target+"/api/login", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out loginResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func postProduct(t *testing.T, target, token string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, target+"/api/products",
		bytes.NewReader([]byte(`{"name":"Test lot","imageUrl":"http://img.local/x.jpg","description":"d"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestSellerKeyGateOnCreation(t *testing.T) {
	target, srv := startTestServer(t)
	srv.cfg.SellerKey = "demo-seller-key"

	// Plain login: user_* namespace, role user — and creation is refused.
	resp, buyer := postLogin(t, target, `{"nickname":"wayne"}`)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(buyer.UserID, "user_") || buyer.Role != "user" {
		t.Fatalf("plain login = %d %+v, want 200 user_*/user", resp.StatusCode, buyer)
	}
	if code := postProduct(t, target, buyer.Token); code != http.StatusForbidden {
		t.Fatalf("buyer create product status=%d want 403", code)
	}

	// Wrong key: rejected outright.
	if resp, _ := postLogin(t, target, `{"nickname":"wayne","sellerKey":"WRONG"}`); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong sellerKey status=%d want 403", resp.StatusCode)
	}

	// Right key: seller_* namespace, role seller — creation passes.
	resp, seller := postLogin(t, target, `{"nickname":"shopkeeper","sellerKey":"demo-seller-key"}`)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(seller.UserID, "seller_") || seller.Role != "seller" {
		t.Fatalf("seller login = %d %+v, want 200 seller_*/seller", resp.StatusCode, seller)
	}
	if code := postProduct(t, target, seller.Token); code != http.StatusOK {
		t.Fatalf("seller create product status=%d want 200", code)
	}

	// Impersonation: plain login under the seller's nickname lands in user_*,
	// never seller_* — still refused.
	_, mallory := postLogin(t, target, `{"nickname":"shopkeeper"}`)
	if strings.HasPrefix(mallory.UserID, "seller_") {
		t.Fatalf("plain login minted seller namespace: %+v", mallory)
	}
	if code := postProduct(t, target, mallory.Token); code != http.StatusForbidden {
		t.Fatalf("impersonator create product status=%d want 403", code)
	}
}

func TestSellerGateOpenModeWithoutKey(t *testing.T) {
	target, srv := startTestServer(t)
	srv.cfg.SellerKey = "" // default: open mode, today's dev/demo/seed flows unchanged

	// Plain sessions can still create (back-compat).
	_, buyer := postLogin(t, target, `{"nickname":"seedscript"}`)
	if code := postProduct(t, target, buyer.Token); code != http.StatusOK {
		t.Fatalf("open-mode plain create status=%d want 200", code)
	}

	// Any non-empty sellerKey is accepted and still mints the seller namespace
	// (so the /admin gate works out of the box before the env is configured).
	resp, seller := postLogin(t, target, `{"nickname":"seller","sellerKey":"anything"}`)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(seller.UserID, "seller_") || seller.Role != "seller" {
		t.Fatalf("open-mode seller login = %d %+v, want 200 seller_*/seller", resp.StatusCode, seller)
	}
}
