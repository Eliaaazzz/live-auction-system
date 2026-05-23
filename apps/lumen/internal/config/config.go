// Package config loads runtime configuration from the environment and enforces
// the §8 security baseline at startup (fail fast outside dev).
package config

import (
	"fmt"
	"os"
)

type Config struct {
	HTTPAddr       string
	MySQLDSN       string
	RedisAddr      string
	AISidecarURL   string
	JWTSecret      string
	FrontendOrigin string
	AppEnv         string
	EnableDevLogin bool
}

const defaultJWTSecret = "change-me-local-only"

// Load reads env and validates the security baseline. It returns an error
// (so the process exits non-zero) when an unsafe combination is detected.
func Load() (Config, error) {
	c := Config{
		HTTPAddr:       env("HTTP_ADDR", ":8080"),
		MySQLDSN:       env("MYSQL_DSN", "lumen:lumen@tcp(localhost:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4"),
		RedisAddr:      env("REDIS_ADDR", "localhost:6379"),
		AISidecarURL:   env("AI_SIDECAR_URL", "http://localhost:8090"),
		JWTSecret:      env("JWT_SECRET", defaultJWTSecret),
		FrontendOrigin: env("FRONTEND_ORIGIN", "http://localhost:8080"),
		AppEnv:         env("APP_ENV", "dev"),
		EnableDevLogin: env("ENABLE_DEV_LOGIN", "true") == "true",
	}

	// §8: outside dev the default signing secret and dev-login must be off.
	if c.AppEnv != "dev" {
		if c.JWTSecret == defaultJWTSecret || c.JWTSecret == "" {
			return c, fmt.Errorf("JWT_SECRET must be set to a non-default value when APP_ENV=%q", c.AppEnv)
		}
		if c.EnableDevLogin {
			return c, fmt.Errorf("ENABLE_DEV_LOGIN must be false when APP_ENV=%q", c.AppEnv)
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
