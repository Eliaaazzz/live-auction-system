package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

const testEvidenceHMACKey = "test-evidence-key"

func TestT4VerifyEvidenceCLIExitCodes(t *testing.T) {
	st := cliTestStore(t)
	ctx := context.Background()
	suffix := time.Now().UnixNano()
	okAid := fmt.Sprintf("cli_verify_ok_%d", suffix)
	badAid := fmt.Sprintf("cli_verify_bad_%d", suffix)
	t.Cleanup(func() {
		_, _ = st.DB().ExecContext(context.Background(), "DELETE FROM auction_events WHERE auction_id IN (?, ?)", okAid, badAid)
	})

	if err := st.InsertEvent(ctx, okAid, 1, model.TypeBidAccepted, `{"seq":1,"userId":"u1","amountCents":"11000"}`); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertEvent(ctx, badAid, 1, model.TypeBidAccepted, `{"seq":1,"userId":"u1","amountCents":"11000"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().ExecContext(ctx, "UPDATE auction_events SET event_hash=? WHERE auction_id=? AND seq=1", "tampered", badAid); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name     string
		aid      string
		wantCode int
		wantText string
	}{
		{
			name:     "consistent chain exits zero",
			aid:      okAid,
			wantCode: 0,
			wantText: "evidence chain consistent: events=1",
		},
		{
			name:     "hash break exits one",
			aid:      badAid,
			wantCode: 1,
			wantText: "hash_break_at_seq=1",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=TestT4VerifyEvidenceCLIHelper", "--", "verify-evidence", "--auction", tc.aid)
			cmd.Env = append(os.Environ(),
				"GO_WANT_VERIFY_EVIDENCE_CLI_HELPER=1",
				"REDIS_ADDR="+envOr("REDIS_ADDR", "127.0.0.1:6379"),
				"MYSQL_DSN="+envOr("MYSQL_DSN", "lumen:lumen@tcp(127.0.0.1:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4"),
				"EVIDENCE_HMAC_KEY="+testEvidenceHMACKey,
			)
			out, err := cmd.CombinedOutput()
			gotCode := 0
			if err != nil {
				exitErr, ok := err.(*exec.ExitError)
				if !ok {
					t.Fatalf("verify-evidence helper failed without exit code: %v\n%s", err, out)
				}
				gotCode = exitErr.ExitCode()
			}
			if gotCode != tc.wantCode {
				t.Fatalf("exit code=%d want %d\n%s", gotCode, tc.wantCode, out)
			}
			if !strings.Contains(string(out), tc.wantText) {
				t.Fatalf("output missing %q:\n%s", tc.wantText, out)
			}
		})
	}
}

func TestT4VerifyEvidenceCLIHelper(t *testing.T) {
	if os.Getenv("GO_WANT_VERIFY_EVIDENCE_CLI_HELPER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{"lumen"}, os.Args[i+1:]...)
			main()
			return
		}
	}
	t.Fatal("missing -- separator for helper argv")
}

func cliTestStore(t *testing.T) *store.Store {
	t.Helper()
	redisAddr := envOr("REDIS_ADDR", "127.0.0.1:6379")
	dsn := envOr("MYSQL_DSN", "lumen:lumen@tcp(127.0.0.1:3306)/lumen?parseTime=true&loc=UTC&charset=utf8mb4")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	rc := redis.NewClient(&redis.Options{Addr: redisAddr})
	rerr := rc.Ping(ctx).Err()
	_ = rc.Close()
	db, derr := sql.Open("mysql", dsn)
	var perr error
	if derr == nil {
		perr = db.PingContext(ctx)
		_ = db.Close()
	}
	if rerr != nil || derr != nil || perr != nil {
		t.Skipf("full store unavailable (redis=%v mysql_open=%v mysql_ping=%v)", rerr, derr, perr)
	}
	st, err := store.New(context.Background(), redisAddr, dsn, testEvidenceHMACKey)
	if err != nil {
		t.Skipf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
