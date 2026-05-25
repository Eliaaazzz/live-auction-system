# Component 06 — Auction API (REST)

> **Path**: `apps/lumen/internal/api/` + `apps/lumen/cmd/lumen/main.go` (mode=api)
> **Owner discipline**: leader; OpenAPI shape is **all-member approve** (V9 §6).
> **Gates trunk**: T1 (seller publish + freeze + start REST flow).
> **Cross-references**: `proto/openapi.yaml`, [02-bid-engine](02-bid-engine.md), [15-security](15-security.md).

## Purpose

REST surface for everything that isn't a hot-path bid: product / auction / rule CRUD, freeze, start, cancel commands; order retrieval; evidence card retrieval; dev-login; image upload; **snapshot fallback** for WS catchup overflow. Hot bidding lives on WS — REST is for setup, retrieval, and recovery.

Uses Gin or Fiber (decided by leader in T0b — leans Fiber for performance, Gin for ecosystem). Either way the handler interfaces stay the same — using a thin adapter pattern.

## Directory layout

```
apps/lumen/internal/api/
├── server.go              router setup, middleware chain
├── handler/
│   ├── product.go         CRUD /products
│   ├── auction.go         /auctions {create, get, list, freeze, start, cancel}
│   ├── rules.go           /auctions/{id}/rules (freeze flow)
│   ├── order.go           /orders {get, list, mock-pay}
│   ├── evidence.go        /auctions/{id}/evidence (built on demand)
│   ├── snapshot.go        /auctions/{id}/snapshot (ROOM_SNAPSHOT fallback)
│   ├── upload.go          /uploads (image upload, see 15-security)
│   └── devlogin.go        /dev-login (dev env only)
├── middleware/
│   ├── auth.go            JWT validation, sets context userId
│   ├── ownership.go       seller-action ownership check
│   ├── request_id.go      generates / propagates X-Request-Id
│   ├── recover.go         panic → 500 + log
│   └── logging.go         structured slog with auctionId / userId / requestId
├── types.gen.go           generated from openapi.yaml by oapi-codegen
└── server_test.go         per handler
```

## REST surface (mirrors `proto/openapi.yaml`)

### Seller flow

| Method | Path | Purpose | Auth | Ownership |
|---|---|---|---|---|
| `POST` | `/products` | Create product (upload images first) | seller | n/a |
| `GET` | `/products/{id}` | Get product | any | public read |
| `POST` | `/auctions` | Create auction (DRAFT) | seller | sellerUserId = caller |
| `POST` | `/auctions/{id}/facts/regenerate` | Trigger VLM facts draft | seller | owner |
| `POST` | `/auctions/{id}/facts/confirm` | Seller confirms AI facts | seller | owner |
| `PUT` | `/auctions/{id}/rules` | Update rules (DRAFT only) | seller | owner |
| `POST` | `/auctions/{id}/freeze` | Freeze rules → SCHEDULED | seller | owner |
| `POST` | `/auctions/{id}/start` | Start now → LIVE | seller | owner |
| `POST` | `/auctions/{id}/cancel` | Cancel → CANCELLED | seller/admin | owner |

### Public / buyer flow

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/auctions` | List active auctions (paginated) | any |
| `GET` | `/auctions/{id}` | Get auction summary | any |
| `GET` | `/auctions/{id}/snapshot` | Full room state (used by WS catchup overflow) | any |
| `GET` | `/auctions/{id}/evidence` | Evidence card with hash chain | any (post-terminal) |
| `GET` | `/me/orders` | List my orders | any logged-in |
| `GET` | `/orders/{id}` | Get order detail | buyer or seller |
| `POST` | `/orders/{id}/mock-pay` | Mark order PAID | buyer |

### Dev / admin

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/dev-login` | Issue JWT for seeded user | dev env only |
| `POST` | `/uploads` | Upload image (returns URL) | any logged-in |
| `GET` | `/healthz` | Health check | none |
| `GET` | `/metrics` | Prometheus metrics — **planned, not wired in T1–T5** (no `promhttp` handler in `main.go` yet; #18 `prometheus.yml` keeps the lumen scrape commented so it doesn't 404/redden) | none (locked down at deploy) |

## Key types

```go
// Types generated from openapi.yaml by oapi-codegen
type CreateAuctionRequest struct {
    ProductID string `json:"productId" validate:"required,uuid"`
    Title     string `json:"title" validate:"required,max=200"`
}

type FreezeRulesRequest struct {
    StartCents     string `json:"startCents" validate:"required,numeric"`  // string at boundary
    IncrementCents string `json:"incrementCents" validate:"required,numeric"`
    CapCents       string `json:"capCents" validate:"required,numeric"`
    DurationMs     int64  `json:"durationMs" validate:"required,min=10000,max=86400000"`
    AntiSnipeMs    int64  `json:"antiSnipeMs" validate:"required,min=0,max=120000"`
}

type AuctionResponse struct {
    ID                string                 `json:"id"`
    ProductID         string                 `json:"productId"`
    Title             string                 `json:"title"`
    Status            string                 `json:"status"`  // DRAFT/SCHEDULED/LIVE/SOLD/NO_BID/CANCELLED/ORDER_CREATED
    Rules             *RulesResponse         `json:"rules,omitempty"`
    CurrentPriceCents string                 `json:"currentPriceCents"`
    TopUserID         string                 `json:"topUserId,omitempty"`
    EndAtMs           int64                  `json:"endAtMs,omitempty"`
    ExtendCount       int32                  `json:"extendCount"`
    Facts             *FactsConfirmed        `json:"facts,omitempty"`
    Seq               int64                  `json:"seq"`
    ServerTimeMs      int64                  `json:"serverTimeMs"`
}

// Snapshot = exact same shape as WS ROOM_SNAPSHOT (per V9 §6 shared $ref)
type RoomSnapshot struct {
    Auction      AuctionResponse  `json:"auction"`
    Leaderboard  []LeaderboardEntry `json:"leaderboard"`  // top 50
    RecentBids   []BidEntry         `json:"recentBids"`   // last 20
    ServerTimeMs int64              `json:"serverTimeMs"`
}
```

## Key handlers

### `POST /auctions/{id}/freeze`

```go
func (h *AuctionHandler) Freeze(c *gin.Context) {
    auctionID := c.Param("id")
    callerID := middleware.UserID(c)

    var req FreezeRulesRequest
    if err := c.BindJSON(&req); err != nil {
        respondErr(c, 400, "ERR_BAD_REQUEST", err.Error())
        return
    }

    // Ownership check
    auction, err := h.svc.Get(c, auctionID)
    if err != nil { respondErr(c, 404, "ERR_NOT_FOUND", ""); return }
    if auction.SellerUserID != callerID {
        respondErr(c, 403, "ERR_NOT_ALLOWED", "not auction owner")
        return
    }

    // Validate amounts at this layer (Lua re-validates)
    start, _ := strconv.ParseInt(req.StartCents, 10, 64)
    inc, _ := strconv.ParseInt(req.IncrementCents, 10, 64)
    cap, _ := strconv.ParseInt(req.CapCents, 10, 64)
    if start < 0 || inc <= 0 || cap <= start {
        respondErr(c, 422, "ERR_INVALID_RULES", "")
        return
    }
    if req.AntiSnipeMs > req.DurationMs {
        respondErr(c, 422, "ERR_INVALID_RULES", "antiSnipeMs > durationMs")
        return
    }

    // Call Bid Engine → freeze_rules.lua
    result, err := h.engine.Freeze(c, bidengine.FreezeRequest{
        AuctionID:      auctionID,
        StartCents:     start,
        IncrementCents: inc,
        CapCents:       cap,
        DurationMs:     req.DurationMs,
        AntiSnipeMs:    req.AntiSnipeMs,
    })
    if err != nil {
        respondErr(c, 500, "ERR_ENGINE", err.Error())
        return
    }
    switch result.Code {
    case "OK_FROZEN":
        c.JSON(200, auctionResponseFromResult(result))
    case "ERR_BAD_STATE":
        respondErr(c, 409, "ERR_BAD_STATE", "auction must be in DRAFT")
    default:
        respondErr(c, 500, "ERR_INTERNAL", string(result.Code))
    }
}
```

### `POST /auctions/{id}/start`

```go
func (h *AuctionHandler) Start(c *gin.Context) {
    auctionID := c.Param("id")
    callerID := middleware.UserID(c)
    if err := h.svc.RequireOwner(c, auctionID, callerID); err != nil {
        respondErr(c, 403, "ERR_NOT_ALLOWED", "")
        return
    }
    result, err := h.engine.Start(c, auctionID)
    if err != nil { respondErr(c, 500, "ERR_ENGINE", err.Error()); return }
    switch result.Code {
    case "OK_LIVE":
        c.JSON(200, gin.H{
            "id":           auctionID,
            "status":       "LIVE",
            "endAtMs":      result.EndAtMs,
            "serverTimeMs": result.ServerTimeMs,
            "seq":          result.Seq,
        })
    case "ERR_BAD_STATE":
        respondErr(c, 409, "ERR_BAD_STATE", "auction must be SCHEDULED")
    default:
        respondErr(c, 500, "ERR_INTERNAL", string(result.Code))
    }
}
```

### `POST /auctions/{id}/cancel`

```go
func (h *AuctionHandler) Cancel(c *gin.Context) {
    auctionID := c.Param("id")
    callerID := middleware.UserID(c)
    var req struct{ Reason string `json:"reason"` }
    c.BindJSON(&req)

    // Either auction owner or admin role
    auction, err := h.svc.Get(c, auctionID)
    if err != nil { respondErr(c, 404, "ERR_NOT_FOUND", ""); return }
    if auction.SellerUserID != callerID && !middleware.IsAdmin(c) {
        respondErr(c, 403, "ERR_NOT_ALLOWED", "")
        return
    }

    result, err := h.engine.Cancel(c, bidengine.CancelRequest{
        AuctionID:   auctionID,
        ActorUserID: callerID,
        Reason:      req.Reason,
    })
    // ... map result codes similar to Freeze/Start
}
```

### `GET /auctions/{id}/snapshot`

**CRITICAL**: returns the exact same shape as WS `ROOM_SNAPSHOT` event (per V9 §6 shared `$ref`). Used by `WsClient` when catchup gap > 200 events (per [01-ws-gateway](01-ws-gateway.md)).

```go
func (h *AuctionHandler) Snapshot(c *gin.Context) {
    auctionID := c.Param("id")
    snap, err := h.svc.BuildSnapshot(c, auctionID)
    if err != nil {
        respondErr(c, 404, "ERR_NOT_FOUND", "")
        return
    }
    c.JSON(200, snap)
}

// service layer:
func (s *Service) BuildSnapshot(ctx context.Context, auctionID string) (*RoomSnapshot, error) {
    // Canonical key names per proto/redis-keys.md (matches PR #19).
    state, err := s.redis.HGetAll(ctx, fmt.Sprintf("auction:{%s}:state", auctionID)).Result()
    if err != nil { return nil, err }
    lb, err := s.redis.ZRevRangeWithScores(ctx, fmt.Sprintf("auction:{%s}:leaderboard", auctionID), 0, 49).Result()
    bids, err := s.redis.XRevRangeN(ctx, fmt.Sprintf("auction:{%s}:events", auctionID), "+", "-", 20).Result()
    nowMs := time.Now().UnixMilli()
    return assembleSnapshot(state, lb, bids, nowMs), nil
}
```

### `GET /auctions/{id}/evidence`

```go
func (h *EvidenceHandler) Get(c *gin.Context) {
    auctionID := c.Param("id")
    // Read auction (must be terminal)
    a, err := h.svc.Get(c, auctionID)
    if err != nil { respondErr(c, 404, "ERR_NOT_FOUND", ""); return }
    if !isTerminal(a.Status) {
        respondErr(c, 409, "ERR_NOT_TERMINAL", "evidence only available after auction ends")
        return
    }

    card, err := h.evidence.Build(c, auctionID)
    if err != nil { respondErr(c, 500, "ERR_INTERNAL", err.Error()); return }
    c.JSON(200, card)
}
```

`evidence.Build` reads all events from MySQL `auction_events`, walks the hash chain, and assembles the card. Per `proto/evidence-card.md`, includes: confirmed facts snapshot, frozen rules, complete bid timeline with timestamps, seq range, chain head hash, anti-snipe extension log, terminal reason.

### `POST /dev-login`

```go
func (h *DevLoginHandler) Issue(c *gin.Context) {
    if h.env != "development" {
        respondErr(c, 404, "ERR_NOT_FOUND", "")
        return
    }
    var req struct{ UserID string `json:"userId"` }
    if err := c.BindJSON(&req); err != nil {
        respondErr(c, 400, "ERR_BAD_REQUEST", "")
        return
    }
    user, err := h.svc.GetSeededUser(c, req.UserID)
    if err != nil { respondErr(c, 404, "ERR_NOT_FOUND", ""); return }

    token, err := h.auth.Issue(user.ID, user.DisplayName)
    if err != nil { respondErr(c, 500, "ERR_INTERNAL", ""); return }
    c.JSON(200, gin.H{"token": token, "user": user})
}
```

## Middleware chain (order matters)

1. `request_id.go` — generate / propagate `X-Request-Id`
2. `recover.go` — catch panics
3. `logging.go` — log request/response with structured fields
4. `cors.go` — CORS for admin/mobile origins
5. `auth.go` — validate JWT, set `c.userId` in context (except `/healthz`, `/dev-login`, `/metrics`)
6. Handler

## Test surface (Go)

| Test | Verifies |
|---|---|
| `TestFreeze_HappyPath` | DRAFT auction → freeze → status SCHEDULED, rules visible |
| `TestFreeze_NotOwner_403` | non-owner caller → 403 ERR_NOT_ALLOWED |
| `TestFreeze_AfterStart_409` | LIVE auction → freeze → 409 ERR_BAD_STATE |
| `TestStart_HappyPath` | SCHEDULED → start → LIVE with endAtMs set |
| `TestStart_NotScheduled_409` | DRAFT → start → 409 |
| `TestCancel_OwnerAllowed` | seller cancels own LIVE auction → 200, status CANCELLED |
| `TestCancel_AdminAllowed` | admin cancels any auction → 200 |
| `TestCancel_BuyerForbidden_403` | non-seller non-admin → 403 |
| `TestSnapshot_MatchesWSShape` | snapshot JSON matches schema of WS ROOM_SNAPSHOT event |
| `TestSnapshot_Top50Leaderboard` | 60 bidders → snapshot returns top 50 |
| `TestEvidence_NotTerminal_409` | LIVE auction → evidence → 409 ERR_NOT_TERMINAL |
| `TestEvidence_HashChainComplete` | SOLD auction → evidence card has chainHead matching last event hash |
| `TestDevLogin_ProdReturns404` | env=production → POST /dev-login → 404 |
| `TestDevLogin_UnknownUser_404` | dev env + unknown userId → 404 |
| `TestMiddleware_UnauthenticatedRejected` | no token on protected endpoint → 401 |
| `TestMiddleware_RequestIdPropagated` | client sends X-Request-Id → response echoes |
| `TestRulesValidation_AntiSnipeOverDuration` | antiSnipeMs > durationMs → 422 |

Coverage target: **≥80%**.

## NEEDS HUMAN REVIEW

1. **Gin vs Fiber**: both fine. Fiber is faster but smaller ecosystem. **My vote: Gin** — better docs, more reviewer familiarity, perf delta negligible for REST.
2. **Validation library**: `go-playground/validator` is standard. OK.
3. **Snapshot freshness**: HGETALL is a point-in-time read. Tiny race with concurrent updates. For snapshot-as-fallback semantics, "approximately consistent" is fine.
4. **Evidence built on demand vs prebuilt**: I implemented on-demand (read MySQL when requested). Trade-off: each request reads all events. For demo (1-2 evidence views per auction), this is fine. For production scale, pre-build at AUCTION_SOLD. P0: on-demand.
5. **Pagination**: `/auctions` list needs cursor/limit. Default limit 20, max 100.
6. **Idempotency keys on POST**: not implemented. If a seller double-clicks "Start", we get two Start calls. The Lua handles it (`ERR_BAD_STATE` on second), but the HTTP response on the second call is 409 — confusing UX. P1: add `Idempotency-Key` header support; P0: client debounces.
