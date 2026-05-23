package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
)

// RunE2E drives the full T1 demo path against a running stack and asserts the
// roundtrip. It is the executable form of the #17 acceptance bar. Returns an
// error (exit != 0) on any failed assertion.
func RunE2E(target string) error {
	hc := &http.Client{Timeout: 5 * time.Second}

	seller, err := devLogin(hc, target, "Seller E2E", "seller")
	if err != nil {
		return fmt.Errorf("seller dev-login: %w", err)
	}
	productID, err := createProduct(hc, target, seller.Token)
	if err != nil {
		return fmt.Errorf("create product: %w", err)
	}
	if err := assertFactsMock(hc, target, seller.Token, productID); err != nil {
		return fmt.Errorf("ai facts mock: %w", err)
	}
	auctionID, err := createAuction(hc, target, seller.Token, productID)
	if err != nil {
		return fmt.Errorf("create auction: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+auctionID+"/freeze", seller.Token, nil, model.CodeOKFrozen); err != nil {
		return fmt.Errorf("freeze: %w", err)
	}
	if err := postExpectCode(hc, target+"/api/auctions/"+auctionID+"/start", seller.Token, map[string]int64{"durationMs": 60000}, model.CodeOKLive); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	buyer, err := devLogin(hc, target, "Buyer E2E", "user")
	if err != nil {
		return fmt.Errorf("buyer dev-login: %w", err)
	}

	// observer joins first (and confirms join via ROOM_SNAPSHOT) so it cannot
	// miss the broadcast — there is no catchup in T1.
	observer, err := dialAndJoin(target, buyer.Token, auctionID)
	if err != nil {
		return fmt.Errorf("observer connect: %w", err)
	}
	defer observer.Close()
	bidder, err := dialAndJoin(target, buyer.Token, auctionID)
	if err != nil {
		return fmt.Errorf("bidder connect: %w", err)
	}
	defer bidder.Close()

	bid, _ := model.NewEnvelope(model.TypeBidPlace, auctionID, 0, model.BidPlaceData{
		ClientBidID: fmt.Sprintf("cb_%d", time.Now().UnixNano()),
		AmountCents: "11000",
	})
	if err := bidder.WriteJSON(bid); err != nil {
		return fmt.Errorf("send bid: %w", err)
	}

	// Both the originating bidder (direct ack) and the observer (Pub/Sub
	// broadcast) must receive BID_ACCEPTED.
	if err := waitForType(bidder, model.TypeBidAccepted, 5*time.Second); err != nil {
		return fmt.Errorf("bidder did not receive its BID_ACCEPTED ack: %w", err)
	}
	if err := waitForType(observer, model.TypeBidAccepted, 5*time.Second); err != nil {
		return fmt.Errorf("observer did not receive BID_ACCEPTED: %w", err)
	}
	if err := waitEventsCount(hc, target, auctionID, 1, 5*time.Second); err != nil {
		return fmt.Errorf("persistence projection: %w", err)
	}

	fmt.Println("e2e-dummy-bid: PASS")
	return nil
}

type session struct {
	UserID string `json:"userId"`
	Token  string `json:"token"`
}

func devLogin(hc *http.Client, target, nickname, role string) (session, error) {
	var s session
	err := postJSON(hc, target+"/api/dev-login", "", map[string]string{"nickname": nickname, "role": role}, &s)
	return s, err
}

func createProduct(hc *http.Client, target, token string) (string, error) {
	var out struct {
		ProductID string `json:"productId"`
	}
	err := postJSON(hc, target+"/api/products", token,
		map[string]string{"name": "E2E Watch", "imageUrl": "https://example.com/w.jpg", "description": "e2e"}, &out)
	return out.ProductID, err
}

func createAuction(hc *http.Client, target, token, productID string) (string, error) {
	var out struct {
		AuctionID string `json:"auctionId"`
	}
	body := map[string]any{
		"productId": productID,
		"rules": model.Rules{
			StartPriceCents: 10000, IncrementCents: 1000, CapPriceCents: 1000000,
			DurationSec: 60, ExtendWindowSec: 10, ExtendSec: 10,
		},
		"factsConfirmed": true, // seller confirmed the AI facts draft
	}
	err := postJSON(hc, target+"/api/auctions", token, body, &out)
	return out.AuctionID, err
}

func assertFactsMock(hc *http.Client, target, token, productID string) error {
	var out struct {
		HighRiskFieldsDisclaimer string `json:"highRiskFieldsDisclaimer"`
	}
	if err := postJSON(hc, target+"/api/facts/draft", token,
		map[string]any{"productId": productID, "imageUrls": []string{"https://example.com/w.jpg"}}, &out); err != nil {
		return err
	}
	if out.HighRiskFieldsDisclaimer == "" {
		return fmt.Errorf("facts mock missing highRiskFieldsDisclaimer")
	}
	return nil
}

func dialAndJoin(target, token, aid string) (*websocket.Conn, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/ws?token=%s", scheme, u.Host, url.QueryEscape(token))
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return nil, err
	}
	join, _ := model.NewEnvelope(model.TypeRoomJoin, aid, 0, model.RoomJoinData{AuctionID: aid})
	if err := c.WriteJSON(join); err != nil {
		c.Close()
		return nil, err
	}
	if err := waitForType(c, model.TypeRoomSnapshot, 5*time.Second); err != nil {
		c.Close()
		return nil, fmt.Errorf("no ROOM_SNAPSHOT: %w", err)
	}
	return c, nil
}

func waitForType(c *websocket.Conn, typ string, d time.Duration) error {
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		var env model.Envelope
		if err := c.ReadJSON(&env); err != nil {
			return err
		}
		if env.Type == typ {
			return nil
		}
	}
}

func waitEventsCount(hc *http.Client, target, aid string, want int, d time.Duration) error {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		var out struct {
			Count int `json:"count"`
		}
		if err := getJSON(hc, target+"/api/auctions/"+aid+"/events-count", &out); err == nil && out.Count >= want {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("events-count did not reach %d within %s", want, d)
}

// postExpectCode posts and asserts the JSON response {"code": <want>}.
func postExpectCode(hc *http.Client, urlStr, token string, body any, want string) error {
	var out struct {
		Code string `json:"code"`
	}
	if err := postJSON(hc, urlStr, token, body, &out); err != nil {
		return err
	}
	if out.Code != want {
		return fmt.Errorf("got code %q, want %q", out.Code, want)
	}
	return nil
}

func postJSON(hc *http.Client, urlStr, token string, body, out any) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequest(http.MethodPost, urlStr, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return doJSON(hc, req, out)
}

func getJSON(hc *http.Client, urlStr string, out any) error {
	req, err := http.NewRequest(http.MethodGet, urlStr, nil)
	if err != nil {
		return err
	}
	return doJSON(hc, req, out)
}

func doJSON(hc *http.Client, req *http.Request, out any) error {
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s -> %d: %s", req.Method, req.URL.Path, resp.StatusCode, string(data))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}
