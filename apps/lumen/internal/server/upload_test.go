package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/auth"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
)

// Upload is filesystem + auth only — no Redis/MySQL — so the handler is
// tested directly against a bare Server with just the JWT secret set.

const uploadTestSecret = "upload-test-secret"

func uploadTestServer() *Server {
	return &Server{cfg: config.Config{JWTSecret: uploadTestSecret}}
}

// minimal valid PNG header — enough for http.DetectContentType to say image/png.
var pngMagic = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R'}

// minimal ISO base-media 'ftyp' box (major brand mp42): boxSize=24, data[4:8]=="ftyp",
// data[8:11]=="mp4" — exactly what http.DetectContentType sniffs as video/mp4.
var mp4Magic = []byte{
	0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2',
	0x00, 0x00, 0x00, 0x00, 'i', 's', 'o', 'm', 'm', 'p', '4', '2',
}

func multipartBody(t *testing.T, field, filename string, payload []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return &buf, mw.FormDataContentType()
}

func TestUploadHappyPathStoresFileAndReturnsURL(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	payload := append(append([]byte{}, pngMagic...), bytes.Repeat([]byte{0xAB}, 1024)...)
	body, ctype := multipartBody(t, "file", "watch.png", payload)

	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	resp := rec.Body.String()
	if !strings.Contains(resp, `"url":"/uploads/`) || !strings.Contains(resp, `.png`) {
		t.Fatalf("unexpected response: %s", resp)
	}

	// The file must exist on disk with the full payload.
	entries, err := os.ReadDir(os.Getenv("UPLOAD_DIR"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("upload dir entries = %v, err = %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(os.Getenv("UPLOAD_DIR"), entries[0].Name()))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("stored bytes = %d, want %d (content mismatch)", len(data), len(payload))
	}
}

func TestUploadRejectsUnauthenticated(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	body, ctype := multipartBody(t, "file", "watch.png", pngMagic)
	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	req.Header.Set("Content-Type", ctype)
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestUploadRejectsNonImagePayload(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	// Extension lies (.png) but the bytes are plain text — sniffing must win.
	body, ctype := multipartBody(t, "file", "evil.png", []byte("#!/bin/sh\necho pwned\n"))
	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	entries, _ := os.ReadDir(os.Getenv("UPLOAD_DIR"))
	if len(entries) != 0 {
		t.Fatalf("rejected upload must not land on disk, found %v", entries)
	}
}

func TestUploadRejectsMissingFileField(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	body, ctype := multipartBody(t, "not-file", "watch.png", pngMagic)
	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestUploadRejectsOversizedPayload(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	payload := append(append([]byte{}, pngMagic...), bytes.Repeat([]byte{0xCD}, maxUploadBytes+128*1024)...)
	body, ctype := multipartBody(t, "file", "huge.png", payload)
	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for oversize, got body: %s", rec.Code, rec.Body.String())
	}
}

// handleUploadVideo is the auction-agnostic byte sink the publish form hits the
// moment a clip is dropped (upload-on-drop). Like handleUpload it's filesystem +
// auth only — no Redis/MySQL — so it tests directly against a bare Server.

func TestUploadVideoHappyPathStoresFileAndReturnsURL(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	payload := append(append([]byte{}, mp4Magic...), bytes.Repeat([]byte{0xAB}, 4096)...)
	body, ctype := multipartBody(t, "file", "clip.mp4", payload)

	req := httptest.NewRequest(http.MethodPost, "/api/upload/video", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUploadVideo(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	resp := rec.Body.String()
	if !strings.Contains(resp, `"url":"/uploads/`) || !strings.Contains(resp, `.mp4`) {
		t.Fatalf("unexpected response: %s", resp)
	}

	// The clip must exist on disk with the full payload — no auction binding.
	entries, err := os.ReadDir(os.Getenv("UPLOAD_DIR"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("upload dir entries = %v, err = %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(os.Getenv("UPLOAD_DIR"), entries[0].Name()))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("stored bytes = %d, want %d (content mismatch)", len(data), len(payload))
	}
}

func TestUploadVideoRejectsNonVideoPayload(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	// A real PNG offered to the video sink: sniffing must reject it (mp4/webm only).
	body, ctype := multipartBody(t, "file", "watch.mp4", pngMagic)
	req := httptest.NewRequest(http.MethodPost, "/api/upload/video", body)
	req.Header.Set("Content-Type", ctype)
	req.Header.Set("Authorization", "Bearer "+auth.Token(uploadTestSecret, "seller-1"))
	rec := httptest.NewRecorder()
	s.handleUploadVideo(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	entries, _ := os.ReadDir(os.Getenv("UPLOAD_DIR"))
	if len(entries) != 0 {
		t.Fatalf("rejected upload must not land on disk, found %v", entries)
	}
}

func TestUploadVideoRejectsUnauthenticated(t *testing.T) {
	t.Setenv("UPLOAD_DIR", t.TempDir())
	s := uploadTestServer()

	body, ctype := multipartBody(t, "file", "clip.mp4", mp4Magic)
	req := httptest.NewRequest(http.MethodPost, "/api/upload/video", body)
	req.Header.Set("Content-Type", ctype)
	rec := httptest.NewRecorder()
	s.handleUploadVideo(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestVideoExtAllowlist(t *testing.T) {
	cases := []struct {
		ctype string
		ext   string
		ok    bool
	}{
		{"video/mp4", ".mp4", true},
		{"video/webm", ".webm", true},
		{"image/png", "", false},
		{"application/octet-stream", "", false},
		{"text/html; charset=utf-8", "", false},
	}
	for _, c := range cases {
		ext, ok := videoExt(c.ctype)
		if ext != c.ext || ok != c.ok {
			t.Errorf("videoExt(%q) = (%q, %v), want (%q, %v)", c.ctype, ext, ok, c.ext, c.ok)
		}
	}
}

func TestImageExtAllowlist(t *testing.T) {
	cases := []struct {
		ctype string
		ext   string
		ok    bool
	}{
		{"image/png", ".png", true},
		{"image/jpeg", ".jpg", true},
		{"image/webp", ".webp", true},
		{"image/gif", ".gif", true},
		{"image/svg+xml", "", false}, // scriptable — never serve back
		{"text/html; charset=utf-8", "", false},
		{"application/pdf", "", false},
	}
	for _, c := range cases {
		ext, ok := imageExt(c.ctype)
		if ext != c.ext || ok != c.ok {
			t.Errorf("imageExt(%q) = (%q, %v), want (%q, %v)", c.ctype, ext, ok, c.ext, c.ok)
		}
	}
}
