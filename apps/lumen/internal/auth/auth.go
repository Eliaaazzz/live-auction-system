// Package auth provides T1 dev-login tokens (HMAC-signed userId) and origin
// checking. Full JWT/OTP is P1; this is the dev-only minimal credential.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// Token returns "<userID>.<hmacHex>" signed with secret.
func Token(secret, userID string) string {
	return userID + "." + sign(secret, userID)
}

// Verify checks the token and returns the userID, or an error.
func Verify(secret, token string) (string, error) {
	userID, _, ok := strings.Cut(token, ".")
	if !ok {
		return "", errors.New("malformed token")
	}
	if !hmac.Equal([]byte(token), []byte(Token(secret, userID))) {
		return "", errors.New("invalid token signature")
	}
	return userID, nil
}

func sign(secret, msg string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}

// OriginAllowed implements the §8 WS Origin allowlist (CSWSH guard). An empty
// origin (non-browser clients such as the e2e harness) is allowed; a present
// origin must match the configured frontend origin exactly.
func OriginAllowed(origin, allowed string) bool {
	return origin == "" || origin == allowed
}
