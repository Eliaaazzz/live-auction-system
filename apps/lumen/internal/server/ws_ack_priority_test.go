package server

import (
	"testing"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

func TestDirectOutcomeUsesPriorityLaneAheadOfBroadcast(t *testing.T) {
	aid := "auc_priority"
	c := &Conn{
		aid:       aid,
		crit:      make(chan outboundFrame, 2),
		broadcast: make(chan outboundFrame, 2),
		done:      make(chan struct{}),
	}

	pm, err := websocket.NewPreparedMessage(websocket.TextMessage, []byte(`{"type":"ROOM_STATE_PATCH"}`))
	if err != nil {
		t.Fatal(err)
	}
	c.trySendPrepared(aid, pm)
	c.push(rejected(aid, model.CodeErrTooLow))

	select {
	case <-c.crit:
	default:
		t.Fatal("direct BID_REJECTED was not enqueued on priority lane")
	}
	select {
	case <-c.broadcast:
	default:
		t.Fatal("room fanout was not enqueued on broadcast lane")
	}
}
