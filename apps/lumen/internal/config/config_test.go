package config

import "testing"

// HT-092 (review doc): outside dev, the §8 baseline must fail fast — the default
// signing secret and dev-login are forbidden in non-dev environments.
func TestHiddenConfigFailsFastOutsideDev(t *testing.T) {
	prodDSN := "prod-user:prod-pass@tcp(mysql.internal:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4"
	// prod + default JWT secret -> must error.
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "")
	t.Setenv("MYSQL_USER", "")
	t.Setenv("MYSQL_PASSWORD", "")
	t.Setenv("MYSQL_DATABASE", "")
	t.Setenv("JWT_SECRET", defaultJWTSecret)
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", defaultEvidenceKey)
	if _, err := Load(); err == nil {
		t.Fatal("prod + default JWT secret must fail fast")
	}

	// prod + real secret + dev-login on -> must error.
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("MYSQL_DSN", prodDSN)
	t.Setenv("ENABLE_DEV_LOGIN", "true")
	if _, err := Load(); err == nil {
		t.Fatal("prod + ENABLE_DEV_LOGIN=true must fail fast")
	}

	// prod + real secret + dev-login off, but default EVIDENCE_HMAC_KEY -> must error (§6).
	t.Setenv("MYSQL_DSN", prodDSN)
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("EVIDENCE_HMAC_KEY", defaultEvidenceKey)
	if _, err := Load(); err == nil {
		t.Fatal("prod + default EVIDENCE_HMAC_KEY must fail fast")
	}

	// prod + all real secrets + dev-login off -> ok.
	t.Setenv("MYSQL_DSN", prodDSN)
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")
	if _, err := Load(); err != nil {
		t.Fatalf("prod + real secrets + dev-login off should pass: %v", err)
	}

	// dev keeps the convenient defaults (the non-default checks are skipped in dev).
	t.Setenv("APP_ENV", "dev")
	t.Setenv("JWT_SECRET", defaultJWTSecret)
	t.Setenv("EVIDENCE_HMAC_KEY", defaultEvidenceKey)
	t.Setenv("ENABLE_DEV_LOGIN", "true")
	if _, err := Load(); err != nil {
		t.Fatalf("dev defaults should pass: %v", err)
	}
}

func TestMySQLDSNResolveFromComponents(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "mysql.internal")
	t.Setenv("MYSQL_USER", "auction")
	t.Setenv("MYSQL_PASSWORD", "secret-pass")
	t.Setenv("MYSQL_PORT", "33306")
	t.Setenv("MYSQL_DATABASE", "lumen")
	t.Setenv("MYSQL_TLS", "skip-verify")
	t.Setenv("JWT_SECRET", "prod-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", "prod-evidence-key")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load should pass with component env: %v", err)
	}
	want := "auction:secret-pass@tcp(mysql.internal:33306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4&tls=skip-verify"
	if cfg.MySQLDSN != want {
		t.Fatalf("mysql dsn=%s want %s", cfg.MySQLDSN, want)
	}
}
