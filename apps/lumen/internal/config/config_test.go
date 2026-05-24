package config

import "testing"

// HT-092 (review doc): outside dev, the §8 baseline must fail fast — the default
// signing secret and dev-login are forbidden in non-dev environments.
func TestHiddenConfigFailsFastOutsideDev(t *testing.T) {
	// prod + default JWT secret -> must error.
	t.Setenv("APP_ENV", "prod")
	t.Setenv("JWT_SECRET", defaultJWTSecret)
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	if _, err := Load(); err == nil {
		t.Fatal("prod + default JWT secret must fail fast")
	}

	// prod + real secret + dev-login on -> must error.
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "true")
	if _, err := Load(); err == nil {
		t.Fatal("prod + ENABLE_DEV_LOGIN=true must fail fast")
	}

	// prod + real secret + dev-login off -> ok.
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	if _, err := Load(); err != nil {
		t.Fatalf("prod + real secret + dev-login off should pass: %v", err)
	}

	// dev keeps the convenient defaults.
	t.Setenv("APP_ENV", "dev")
	t.Setenv("JWT_SECRET", defaultJWTSecret)
	t.Setenv("ENABLE_DEV_LOGIN", "true")
	if _, err := Load(); err != nil {
		t.Fatalf("dev defaults should pass: %v", err)
	}
}
