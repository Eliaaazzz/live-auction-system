package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestVersionEndpointReportsBuildAndSchema(t *testing.T) {
	t.Setenv("LUMEN_BUILD_SHA", "abc1234")
	t.Setenv("LUMEN_BUILD_TIME", "2026-06-05T05:00:00Z")

	s := &Server{cfg: config.Config{AppEnv: "prod"}}
	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rr := httptest.NewRecorder()
	s.handleVersion(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%s", rr.Code, rr.Body.String())
	}
	var got versionInfo
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || got.SchemaVersion != model.SchemaVersion || got.BuildSHA != "abc1234" || got.BuildTime != "2026-06-05T05:00:00Z" || got.AppEnv != "prod" {
		t.Fatalf("version response=%+v", got)
	}
}

func TestVersionEndpointDefaultsBuildIdentity(t *testing.T) {
	s := &Server{cfg: config.Config{AppEnv: "dev"}}
	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rr := httptest.NewRecorder()
	s.handleVersion(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%s", rr.Code, rr.Body.String())
	}
	var got versionInfo
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.BuildSHA != unknownBuildValue || got.BuildTime != unknownBuildValue || got.SchemaVersion != model.SchemaVersion || got.AppEnv != "dev" {
		t.Fatalf("default version response=%+v", got)
	}
}
