package server

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

// Product-image upload (商家端 竞拍发布 — spec asks for real upload, not a URL
// field). Files land on local disk under uploadDir() and are served back at
// /uploads/<name> by routes(); the create-product flow then stores that URL
// in imageUrl exactly as before, so the room / VLM page need no changes.

// maxUploadBytes caps a single product still. 5 MiB is generous for a photo
// and small enough that a phone on hotel wifi finishes before the demo ends.
const maxUploadBytes = 5 << 20

// uploadDir resolves where uploaded media lands. Env override lets the
// container mount a volume; the default sits next to the process binary.
func uploadDir() string {
	if d := os.Getenv("UPLOAD_DIR"); d != "" {
		return d
	}
	return "./data/uploads"
}

// handleUpload — POST /api/upload, multipart field "file". Auth-gated (any
// session; sellers come through dev-login like every other seller endpoint).
// The content type is sniffed from the first 512 bytes — extensions lie, the
// magic bytes don't — and only static image formats pass.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authUser(r); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// MaxBytesReader guards the copy below; the small slack covers the
	// multipart framing around the 5 MiB payload itself.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+64*1024)
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, `missing multipart field "file" (max 5MB)`)
		return
	}
	defer file.Close()

	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "unreadable upload")
		return
	}
	head = head[:n]
	ext, ok := imageExt(http.DetectContentType(head))
	if !ok {
		writeErr(w, http.StatusBadRequest, "unsupported image type — png / jpeg / webp / gif only")
		return
	}

	dir := uploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "upload dir unavailable")
		return
	}
	// Server-generated name: timestamp + random token. The client filename is
	// untrusted input and never touches the filesystem path.
	name := fmt.Sprintf("%d-%s%s", time.Now().UnixMilli(), randToken(8), ext)
	path := filepath.Join(dir, name)
	dst, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "upload write failed")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, io.MultiReader(bytes.NewReader(head), file)); err != nil {
		_ = os.Remove(path)
		writeErr(w, http.StatusInternalServerError, "upload write failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"url": "/uploads/" + name})
}

// maxVideoBytes caps a single 开始直播 clip. 64 MiB holds a short, looping
// product walkaround at sane bitrate; anything heavier should be compressed so
// the mobile room (which downloads it as a muted background loop) starts fast.
const maxVideoBytes = 64 << 20

// handleUploadStreamVideo — POST /api/auctions/{id}/stream/video, multipart
// field "file". Seller-only (ownsAuction). Lets the anchor drive the live feed
// from a prepared clip instead of OBS: the file lands under uploadDir(), served
// at /uploads/<name>, and its URL is written to the auction's live_play_url so
// the room snapshot (GET /api/auctions/{id}.livePlayUrl) hands it to every
// viewer, who auto-loops it via the existing display-only VideoBackground.
// Stays off the Redis/Lua bid hot path — purely the cosmetic video layer.
func (s *Server) handleUploadStreamVideo(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authUser(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	aid := r.PathValue("id")
	if _, ok := s.ownsAuction(w, r, aid, userID); !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxVideoBytes+256*1024)
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, `missing multipart field "file" (max 64MB)`)
		return
	}
	defer file.Close()

	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		writeErr(w, http.StatusBadRequest, "unreadable upload")
		return
	}
	head = head[:n]
	ext, ok := videoExt(http.DetectContentType(head))
	if !ok {
		writeErr(w, http.StatusBadRequest, "unsupported video type — mp4 / webm only")
		return
	}

	dir := uploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "upload dir unavailable")
		return
	}
	name := fmt.Sprintf("%d-%s%s", time.Now().UnixMilli(), randToken(8), ext)
	path := filepath.Join(dir, name)
	dst, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "upload write failed")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, io.MultiReader(bytes.NewReader(head), file)); err != nil {
		_ = os.Remove(path)
		writeErr(w, http.StatusInternalServerError, "upload write failed")
		return
	}

	livePlayURL := "/uploads/" + name
	if err := s.st.SetLivePlayURL(r.Context(), aid, livePlayURL); err != nil {
		_ = os.Remove(path)
		if err == store.ErrNotFound {
			writeErr(w, http.StatusNotFound, "rules not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "could not set live feed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"livePlayUrl": livePlayURL})
}

// videoExt maps a sniffed content type to the on-disk extension for live
// clips. Only browser-friendly muted-loop formats pass — mp4 / webm.
func videoExt(ctype string) (string, bool) {
	switch ctype {
	case "video/mp4":
		return ".mp4", true
	case "video/webm":
		return ".webm", true
	}
	return "", false
}

// imageExt maps a sniffed content type to the on-disk extension. Anything
// not in this allowlist is rejected — uploads are product stills, full stop.
func imageExt(ctype string) (string, bool) {
	switch ctype {
	case "image/png":
		return ".png", true
	case "image/jpeg":
		return ".jpg", true
	case "image/webp":
		return ".webp", true
	case "image/gif":
		return ".gif", true
	}
	return "", false
}

func randToken(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		// Practically unreachable; a timestamp keeps the name unique enough.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
