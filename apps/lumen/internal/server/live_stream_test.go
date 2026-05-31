package server

import (
	"strings"
	"testing"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/config"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestJoinStreamURL(t *testing.T) {
	if got := joinStreamURL("http://1.2.3.4:8081/live/", "/abc", ".m3u8"); got != "http://1.2.3.4:8081/live/abc.m3u8" {
		t.Fatalf("joinStreamURL=%q", got)
	}
	if got := joinStreamURL("", "abc", ".m3u8"); got != "" {
		t.Fatalf("empty base joinStreamURL=%q", got)
	}
	if got := joinStreamURL("rtmp://1.2.3.4:1935/live", "abc", ""); got != "rtmp://1.2.3.4:1935/live/abc" {
		t.Fatalf("rtmp joinStreamURL=%q", got)
	}
}

func TestPrepareLiveStreamRulesGeneratesSRSUrls(t *testing.T) {
	s := &Server{cfg: config.Config{
		LivePushURLBase: "rtmp://ecs.example:1935/live",
		LivePlayURLBase: "http://ecs.example:8081/live",
	}}
	rules := model.Rules{}
	s.prepareLiveStreamRules("auc_1", &rules)

	if !strings.HasPrefix(rules.LiveStreamKey, "stream_") {
		t.Fatalf("LiveStreamKey=%q", rules.LiveStreamKey)
	}
	if got, want := rules.LivePlayUrl, "http://ecs.example:8081/live/"+rules.LiveStreamKey+".m3u8"; got != want {
		t.Fatalf("LivePlayUrl=%q want %q", got, want)
	}
	if got, want := s.livePushURL(rules.LiveStreamKey), "rtmp://ecs.example:1935/live/"+rules.LiveStreamKey; got != want {
		t.Fatalf("pushUrl=%q want %q", got, want)
	}
}

func TestPrepareLiveStreamRulesPreservesManualPlayURL(t *testing.T) {
	s := &Server{cfg: config.Config{LivePlayURLBase: "http://ecs.example:8081/live"}}
	rules := model.Rules{LivePlayUrl: "https://play.example/live/manual.m3u8"}
	s.prepareLiveStreamRules("auc_1", &rules)

	if rules.LivePlayUrl != "https://play.example/live/manual.m3u8" {
		t.Fatalf("manual LivePlayUrl overwritten: %q", rules.LivePlayUrl)
	}
	if rules.LiveStreamKey == "" {
		t.Fatal("LiveStreamKey was not generated")
	}
}
