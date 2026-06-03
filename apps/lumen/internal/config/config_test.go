package config

import (
	"net/url"
	"strings"
	"testing"
)

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

func TestLegacyEnvAliases(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MYSQL_DSN", "")
	t.Setenv("MYSQL_URL", "mysql://legacy-user:legacy-pass@mysql.internal:3306/lumen")
	t.Setenv("MYSQL_HOST", "")
	t.Setenv("MYSQL_USER", "")
	t.Setenv("MYSQL_PASSWORD", "")
	t.Setenv("MYSQL_DATABASE", "")
	t.Setenv("MYSQL_PORT", "")
	t.Setenv("MYSQL_TLS", "")
	t.Setenv("REDIS_ADDR", "")
	t.Setenv("REDIS_URL", "redis://redis.internal:6379/0")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with legacy aliases should pass: %v", err)
	}

	if cfg.MySQLDSN != "legacy-user:legacy-pass@tcp(mysql.internal:3306)/lumen?charset=utf8mb4&loc=UTC&parseTime=true" {
		t.Fatalf("mysql dsn=%s", cfg.MySQLDSN)
	}

	if cfg.RedisAddr != "redis.internal:6379" {
		t.Fatalf("redis addr=%s", cfg.RedisAddr)
	}
	if cfg.RedisUseTLS {
		t.Fatalf("redis must not use tls for redis:// input")
	}

	parts := strings.SplitN(cfg.MySQLDSN, "?", 2)
	if len(parts) != 2 {
		t.Fatalf("mysql dsn query missing: %s", cfg.MySQLDSN)
	}
	query, err := url.ParseQuery(parts[1])
	if err != nil {
		t.Fatalf("invalid mysql dsn query: %v", err)
	}
	if got := query.Get("parseTime"); got != "true" {
		t.Fatalf("parseTime=%s", got)
	}
	if got := query.Get("loc"); got != "UTC" {
		t.Fatalf("loc=%s", got)
	}
}

func TestRedisURLWithTLSAndPasswordAlias(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MYSQL_DSN", "prod-user:prod-pass@tcp(mysql.internal:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4")
	t.Setenv("REDIS_ADDR", "")
	t.Setenv("REDIS_URL", "rediss://:redis-pass@redis.internal:6380/0")
	t.Setenv("REDIS_PASSWORD", "override-pass")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with rediss URL should pass: %v", err)
	}
	if cfg.RedisAddr != "redis.internal:6380" {
		t.Fatalf("redis addr=%s", cfg.RedisAddr)
	}
	if !cfg.RedisUseTLS {
		t.Fatal("redis should use tls for rediss://")
	}
	if cfg.RedisPassword != "override-pass" {
		t.Fatalf("redis password=%q", cfg.RedisPassword)
	}
}

func TestRedisURLPasswordFallback(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MYSQL_DSN", "prod-user:prod-pass@tcp(mysql.internal:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4")
	t.Setenv("REDIS_ADDR", "")
	t.Setenv("REDIS_URL", "rediss://:url-pass@redis.internal:6380/0")
	t.Setenv("REDIS_PASSWORD", "")
	t.Setenv("JWT_SECRET", "a-real-production-secret")
	t.Setenv("ENABLE_DEV_LOGIN", "false")
	t.Setenv("EVIDENCE_HMAC_KEY", "a-real-evidence-key")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with rediss URL password should pass: %v", err)
	}
	if cfg.RedisPassword != "url-pass" {
		t.Fatalf("redis password from URL=%q", cfg.RedisPassword)
	}
}
