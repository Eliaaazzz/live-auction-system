// Package config loads runtime configuration from the environment and enforces
// the §8 security baseline at startup (fail fast outside dev).
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	HTTPAddr        string
	MySQLDSN        string
	RedisAddr       string
	RedisUseTLS     bool
	RedisPassword   string
	AISidecarURL    string
	JWTSecret       string
	FrontendOrigin  string
	AppEnv          string
	EnableDevLogin  bool
	EvidenceHMACKey string
}

const defaultJWTSecret = "change-me-local-only"
const defaultMySQLDSN = "lumen:lumen@tcp(localhost:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4"

// defaultEvidenceKey is the dev HMAC key for the auction_events hash chain (T4).
// Per §6 threat model: the key must NOT live in the same DB as the events, else the
// chain is only an integrity/consistency check, not tamper-evidence. Outside dev it
// must be set to a real value (env / GitHub Secret / KMS) — enforced below.
const defaultEvidenceKey = "change-me-evidence-local-only"

// Load reads env and validates the security baseline. It returns an error
// (so the process exits non-zero) when an unsafe combination is detected.
func Load() (Config, error) {
	c := Config{
		HTTPAddr:        env("HTTP_ADDR", ":8080"),
		AISidecarURL:    env("AI_SIDECAR_URL", "http://localhost:8090"),
		JWTSecret:       env("JWT_SECRET", defaultJWTSecret),
		FrontendOrigin:  env("FRONTEND_ORIGIN", "http://localhost:8080"),
		AppEnv:          env("APP_ENV", "dev"),
		EnableDevLogin:  env("ENABLE_DEV_LOGIN", "true") == "true",
		EvidenceHMACKey: env("EVIDENCE_HMAC_KEY", defaultEvidenceKey),
		RedisPassword:   env("REDIS_PASSWORD", ""),
	}
	var err error
	c.RedisAddr, c.RedisUseTLS, redisPasswordFromURL, err := resolveRedisAddr()
	if err != nil {
		return c, err
	}
	if c.RedisPassword == "" && redisPasswordFromURL != "" {
		c.RedisPassword = redisPasswordFromURL
	}
	c.MySQLDSN, err = resolveMySQLDSN(c.AppEnv)
	if err != nil {
		return c, err
	}

	// §8: outside dev the default signing secret and dev-login must be off.
	if c.AppEnv != "dev" {
		if c.JWTSecret == defaultJWTSecret || c.JWTSecret == "" {
			return c, fmt.Errorf("JWT_SECRET must be set to a non-default value when APP_ENV=%q", c.AppEnv)
		}
		if c.EnableDevLogin {
			return c, fmt.Errorf("ENABLE_DEV_LOGIN must be false when APP_ENV=%q", c.AppEnv)
		}
		// §6: the evidence hash chain is only tamper-evident if its HMAC key is not
		// the shipped default (and is held outside the events DB).
		if c.EvidenceHMACKey == defaultEvidenceKey || c.EvidenceHMACKey == "" {
			return c, fmt.Errorf("EVIDENCE_HMAC_KEY must be set to a non-default value when APP_ENV=%q", c.AppEnv)
		}
	}
	return c, nil
}

func resolveMySQLDSN(appEnv string) (string, error) {
	if dsn := strings.TrimSpace(env("MYSQL_DSN", "")); dsn != "" {
		return normalizeMySQLDSN(dsn)
	}

	if dsn := strings.TrimSpace(env("MYSQL_URL", "")); dsn != "" {
		return normalizeMySQLDSN(dsn)
	}

	host := env("MYSQL_HOST", "")
	if host == "" {
		if appEnv == "dev" {
			return defaultMySQLDSN, nil
		}
		return "", fmt.Errorf("MYSQL_DSN or MYSQL_HOST must be set when APP_ENV=%q", appEnv)
	}

	user := env("MYSQL_USER", "")
	password := env("MYSQL_PASSWORD", "")
	database := env("MYSQL_DATABASE", "")
	port := env("MYSQL_PORT", "3306")
	tls := env("MYSQL_TLS", "")

	if user == "" {
		return "", fmt.Errorf("MYSQL_USER must be set when APP_ENV=%q and MYSQL_HOST is used", appEnv)
	}
	if database == "" {
		return "", fmt.Errorf("MYSQL_DATABASE must be set when APP_ENV=%q and MYSQL_HOST is used", appEnv)
	}

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4", user, password, host, port, database)
	if tls != "" {
		dsn += "&tls=" + tls
	}
	return dsn, nil
}

func resolveRedisAddr() (string, bool, string, error) {
	addr := strings.TrimSpace(env("REDIS_ADDR", ""))
	if addr != "" {
		if strings.Contains(addr, "://") {
			return normalizeRedisAddr(addr)
		}
		return addr, false, "", nil
	}
	if raw := strings.TrimSpace(env("REDIS_URL", "")); raw != "" {
		return normalizeRedisAddr(raw)
	}
	return "localhost:6379", false, "", nil
}

func normalizeRedisAddr(raw string) (string, bool, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false, "", fmt.Errorf("REDIS_ADDR/REDIS_URL parse failed: %w", err)
	}
	if u.Scheme != "redis" && u.Scheme != "rediss" {
		return "", false, "", fmt.Errorf("REDIS_ADDR/REDIS_URL must use redis:// or rediss://, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return "", false, "", fmt.Errorf("REDIS_ADDR/REDIS_URL must include host")
	}
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	password, _ := u.User.Password()
	return net.JoinHostPort(host, port), u.Scheme == "rediss", password, nil
}

func normalizeMySQLDSN(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("MYSQL_DSN/MYSQL_URL parse failed: %w", err)
	}
	if u.Scheme != "mysql" {
		return "", fmt.Errorf("MYSQL_DSN/MYSQL_URL has unsupported scheme %q", u.Scheme)
	}
	user := u.User.Username()
	password, _ := u.User.Password()
	host := u.Hostname()
	port := u.Port()
	db := strings.TrimPrefix(u.Path, "/")
	if user == "" {
		return "", fmt.Errorf("MYSQL_DSN/MYSQL_URL must include user info")
	}
	if host == "" {
		return "", fmt.Errorf("MYSQL_DSN/MYSQL_URL must include host")
	}
	if db == "" {
		return "", fmt.Errorf("MYSQL_DSN/MYSQL_URL must include database path")
	}
	if port == "" {
		port = "3306"
	}
	q := u.Query()
	if _, ok := q["parseTime"]; !ok {
		q.Set("parseTime", "true")
	}
	if _, ok := q["loc"]; !ok {
		q.Set("loc", "UTC")
	}
	if _, ok := q["charset"]; !ok {
		q.Set("charset", "utf8mb4")
	}
	encoded := q.Encode()
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s", user, password, net.JoinHostPort(host, port), db)
	if encoded == "" {
		return dsn, nil
	}
	return dsn + "?" + encoded, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
