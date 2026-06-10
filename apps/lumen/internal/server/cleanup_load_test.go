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

func TestExtractAuctionIDFromStateKey(t *testing.T) {
	tests := []struct {
		name string
		key  string
		want string
	}{
		{
			name: "valid with load prefix",
			key:  "auction:{auc_load_abc123}:state",
			want: "auc_load_abc123",
		},
		{
			name: "valid normal auction",
			key:  "auction:{auc_demo}:state",
			want: "auc_demo",
		},
		{
			name: "malformed missing prefix",
			key:  "auction:auc_demo:state",
			want: "",
		},
		{
			name: "malformed missing suffix",
			key:  "auction:{auc_demo}",
			want: "",
		},
		{
			name: "empty auction id",
			key:  "auction:{}:state",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractAuctionIDFromStateKey(tt.key); got != tt.want {
				t.Fatalf("extractAuctionIDFromStateKey(%q)=%q want=%q", tt.key, got, tt.want)
			}
		})
	}
}
