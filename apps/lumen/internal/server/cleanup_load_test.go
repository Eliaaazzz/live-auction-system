package server

import (
	"os"
	"testing"
)

func TestLoadAuctionIDsFromFile(t *testing.T) {
	path := t.TempDir() + "/ids.txt"
	content := "a1, a2\n  a2  ,a3\n\n a4,,\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	ids, err := loadAuctionIDsFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a1", "a2", "a3", "a4"}
	if len(ids) != len(want) {
		t.Fatalf("len=%d want=%d ids=%v", len(ids), len(want), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("ids[%d]=%q want=%q", i, ids[i], want[i])
		}
	}
}

func TestParseRedisInt64(t *testing.T) {
	if got := parseRedisInt64("  123 "); got != 123 {
		t.Fatalf("parseRedisInt64= %d want 123", got)
	}
	if got := parseRedisInt64(""); got != 0 {
		t.Fatalf("blank should map to 0, got %d", got)
	}
	if got := parseRedisInt64("nan"); got != 0 {
		t.Fatalf("invalid should map to 0, got %d", got)
	}
}
