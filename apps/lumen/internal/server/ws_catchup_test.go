package server

// F5/F6 hidden tests (review doc HT-040 / HT-050): the gateway broadcasts only
// Stream-backed events (a forged Pub/Sub message is ignored), and ROOM_JOIN with
// lastSeq replays the missed Stream delta. Use the in-process harness so they run
// in CI without an external stack.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

func dialRaw(t *testing.T, target, token string) *websocket.Conn {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	c, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("%s://%s/ws?token=%s", scheme, u.Host, url.QueryEscape(token)), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// HT-040: a forged Pub/Sub event not backed by the Stream must NOT be broadcast.
func TestT2HiddenForgedPubSubNotBroadcast(t *testing.T) {
	target, srv := startTestServer(t)
	aid := newAID("test_forged")
	liveAuctionFull(t, srv.st, aid) // LIVE, no bids

	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "Forge Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c, err := dialAndJoin(target, buyer.Token, aid)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// publish an event that exists in NO Stream entry.
	fake, _ := json.Marshal(model.PubMessage{
		Type: model.TypeBidAccepted, Seq: 999,
		Data: json.RawMessage(`{"seq":999,"userId":"evil","amountCents":"999999"}`),
	})
	if err := srv.st.Redis().Publish(context.Background(), store.PubChannel(aid), string(fake)).Err(); err != nil {
		t.Fatal(err)
	}
	// the gateway reads the Stream (no seq 999) → nothing broadcast.
	if err := waitForType(c, model.TypeBidAccepted, 800*time.Millisecond); err == nil {
		t.Fatal("forged Pub/Sub event was broadcast; gateway must broadcast only Stream-backed events")
	}
}

// HT-050: ROOM_JOIN with lastSeq replays the missed Stream events before the snapshot.
func TestT2HiddenRoomJoinLastSeqCatchup(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	aid := newAID("test_catchup")
	liveAuctionFull(t, srv.st, aid)

	if code, _, _, err := srv.st.PlaceBid(ctx, aid, "u1", "cb1", "11000", "U1"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid1: code=%s err=%v", code, err)
	}
	if code, _, _, err := srv.st.PlaceBid(ctx, aid, "u2", "cb2", "12000", "U2"); err != nil || code != model.CodeOKAccepted {
		t.Fatalf("bid2: code=%s err=%v", code, err)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "Catchup Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}
	c := dialRaw(t, target, buyer.Token)
	join, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid, LastSeq: 0})
	if err := c.WriteJSON(join); err != nil {
		t.Fatal(err)
	}

	seen := map[int64]bool{}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var got model.Envelope
		if err := c.ReadJSON(&got); err != nil {
			t.Fatalf("read: %v (seen=%v)", err, seen)
		}
		if got.Type == model.TypeBidAccepted {
			seen[got.Seq] = true
		}
		if got.Type == model.TypeRoomSnapshot {
			break // snapshot is sent after the catchup delta
		}
	}
	if !seen[1] || !seen[2] {
		t.Fatalf("catchup did not replay missed events: seen=%v want seq 1 and 2", seen)
	}
}

func TestT2HiddenCatchupDoesNotReplayPastSnapshotSeq(t *testing.T) {
	events := []store.StreamEvent{
		{Seq: 1, Type: model.TypeBidAccepted},
		{Seq: 2, Type: model.TypeBidAccepted},
		{Seq: 3, Type: model.TypeBidAccepted},
	}
	got := eventsUpToSnapshot(events, 2)
	if len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("bounded catchup=%+v, want seq 1 and 2 only", got)
	}
}

func TestT2HiddenRoomJoinSnapshotIncludesAuctionMode(t *testing.T) {
	target, srv := startTestServer(t)
	ctx := context.Background()
	aid := newAID("test_snapshot_mode")

	t.Cleanup(func() {
		if keys, err := srv.st.Redis().Keys(ctx, "auction:{"+aid+"}:*").Result(); err == nil && len(keys) > 0 {
			_ = srv.st.Redis().Del(ctx, keys...).Err()
		}
		_, _ = srv.st.DB().ExecContext(ctx, "DELETE FROM auction_events WHERE auction_id = ?", aid)
		_, _ = srv.st.DB().ExecContext(ctx, "DELETE FROM orders WHERE auction_id = ?", aid)
	})

	rules := model.Rules{
		StartPriceCents: 10000,
		IncrementCents:  1000,
		CapPriceCents:   0,
		DurationSec:     3600,
		AuctionMode:     "VICKREY",
		ExtendWindowSec: 0,
		ExtendSec:       0,
		MaxExtensions:   0,
	}
	if code, err := srv.st.FreezeRules(ctx, aid, "seller_x", rules); err != nil || code != model.CodeOKFrozen {
		t.Fatalf("freeze rules: code=%s err=%v", code, err)
	}
	if code, _, err := srv.st.StartAuction(ctx, aid, 3_600_000); err != nil || code != model.CodeOKLive {
		t.Fatalf("start auction: code=%s err=%v", code, err)
	}

	hc := &http.Client{Timeout: 5 * time.Second}
	buyer, err := devLogin(hc, target, "Snapshot Buyer", "user")
	if err != nil {
		t.Fatal(err)
	}

	c := dialRaw(t, target, buyer.Token)
	join, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid})
	if err := c.WriteJSON(join); err != nil {
		t.Fatalf("ROOM_JOIN write: %v", err)
	}

	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var got model.Envelope
	if err := c.ReadJSON(&got); err != nil {
		t.Fatalf("ROOM_JOIN read: %v", err)
	}
	if got.Type != model.TypeRoomSnapshot {
		t.Fatalf("ROOM_JOIN first message=%s want %s", got.Type, model.TypeRoomSnapshot)
	}
	var snap model.RoomSnapshotData
	if err := json.Unmarshal(got.Data, &snap); err != nil {
		t.Fatalf("room snapshot decode: %v", err)
	}
	if snap.Rules == nil || snap.Rules.AuctionMode != model.AuctionModeSecondPrice {
		t.Fatalf("auctionMode=%q want %q", func() string {
			if snap.Rules == nil {
				return "empty"
			}
			return snap.Rules.AuctionMode
		}(), model.AuctionModeSecondPrice)
	}
}
