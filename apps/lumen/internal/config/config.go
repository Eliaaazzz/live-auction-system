// Package config loads runtime configuration from the environment and enforces
// the §8 security baseline at startup (fail fast outside dev).
package config

import (
	"fmt"
	"os"
)

type Config struct {
	HTTPAddr        string
	MySQLDSN        string
	RedisAddr       string
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
		RedisAddr:       env("REDIS_ADDR", "localhost:6379"),
		AISidecarURL:    env("AI_SIDECAR_URL", "http://localhost:8090"),
		JWTSecret:       env("JWT_SECRET", defaultJWTSecret),
		FrontendOrigin:  env("FRONTEND_ORIGIN", "http://localhost:8080"),
		AppEnv:          env("APP_ENV", "dev"),
		EnableDevLogin:  env("ENABLE_DEV_LOGIN", "true") == "true",
		EvidenceHMACKey: env("EVIDENCE_HMAC_KEY", defaultEvidenceKey),
	}
	var err error
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
	if dsn := env("MYSQL_DSN", ""); dsn != "" {
		return dsn, nil
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

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
