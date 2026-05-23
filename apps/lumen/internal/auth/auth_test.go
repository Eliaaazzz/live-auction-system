package auth

import "testing"

func TestTokenRoundTrip(t *testing.T) {
	tok := Token("secret", "user_1")
	uid, err := Verify("secret", tok)
	if err != nil || uid != "user_1" {
		t.Fatalf("round trip: uid=%q err=%v", uid, err)
	}
}

func TestVerifyRejects(t *testing.T) {
	tok := Token("secret", "user_1")
	if _, err := Verify("secret", tok+"x"); err == nil {
		t.Error("tampered token should fail")
	}
	if _, err := Verify("other-secret", tok); err == nil {
		t.Error("wrong secret should fail")
	}
	if _, err := Verify("secret", "no-separator"); err == nil {
		t.Error("malformed token should fail")
	}
}

func TestOriginAllowed(t *testing.T) {
	if !OriginAllowed("", "http://x") {
		t.Error("empty origin (non-browser) should be allowed")
	}
	if !OriginAllowed("http://x", "http://x") {
		t.Error("matching origin should be allowed")
	}
	if OriginAllowed("http://evil", "http://x") {
		t.Error("mismatched origin should be rejected")
	}
}
