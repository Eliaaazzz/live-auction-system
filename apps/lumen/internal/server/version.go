package server

import (
	"net/http"
	"os"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

const unknownBuildValue = "unknown"

type versionInfo struct {
	Status        string `json:"status"`
	SchemaVersion int    `json:"schemaVersion"`
	BuildSHA      string `json:"buildSha"`
	BuildTime     string `json:"buildTime"`
	AppEnv        string `json:"appEnv"`
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, versionInfo{
		Status:        "ok",
		SchemaVersion: model.SchemaVersion,
		BuildSHA:      envNonEmpty("LUMEN_BUILD_SHA", unknownBuildValue),
		BuildTime:     envNonEmpty("LUMEN_BUILD_TIME", unknownBuildValue),
		AppEnv:        s.cfg.AppEnv,
	})
}

func envNonEmpty(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
