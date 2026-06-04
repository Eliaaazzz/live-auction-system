package config

import (
	"testing"

	"github.com/go-sql-driver/mysql"
)

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

	// prod + real secret + dev-login off, but default EVIDENCE_HMAC_KEY -> must error (§6).
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	if _, err := Load(); err == nil {
		t.Fatal("prod + default EVIDENCE_HMAC_KEY must fail fast")
	}

	// prod + all real secrets + dev-login off -> ok.
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")
	t.Setenv("MYSQL_DSN", "lumen:secret@tcp(mysql.internal:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4")
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

func TestProdRequiresMySQLEndpoint(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "")

	if _, err := Load(); err == nil {
		t.Fatal("prod without MYSQL_DSN or MYSQL_HOST must fail fast")
	}
}

func TestMySQLComponentEnvBuildsDSN(t *testing.T) {
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_HOST", "172.31.12.99")
	t.Setenv("MYSQL_PORT", "3306")
	t.Setenv("MYSQL_USER", "lumen")
	t.Setenv("MYSQL_PASSWORD", "p/@x:?#&%")
	t.Setenv("MYSQL_DATABASE", "lumen")
	t.Setenv("MYSQL_TLS", "skip-verify")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.MySQLDSN == "" {
		t.Fatal("MySQLDSN should be built from component env")
	}
	if cfg.MySQLDSN == "lumen:lumen@tcp(localhost:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4" {
		t.Fatal("MySQLDSN used the local default instead of component env")
	}
	parsed, err := mysql.ParseDSN(cfg.MySQLDSN)
	if err != nil {
		t.Fatalf("ParseDSN() error: %v", err)
	}
	if parsed.Passwd != "p/@x:?#&%" {
		t.Fatalf("password was not preserved: %q", parsed.Passwd)
	}
	if parsed.TLSConfig != "skip-verify" {
		t.Fatalf("TLSConfig=%q, want skip-verify", parsed.TLSConfig)
	}
}
