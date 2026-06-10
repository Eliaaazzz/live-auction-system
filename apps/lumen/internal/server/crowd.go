package server

// crowd.go — 发布即人气 (#261-12a): when the anchor publishes an auction the
// room should not open to crickets. A built-in, server-side crowd script
// injects ~9997 simulated viewers and up to 3992 rule-abiding random bids so
// the demo room feels like a real Douyin live auction from second one.
//
// Engineering boundaries (the part that keeps this safe):
//   - Sim bids go through store.PlaceBid — the SAME Lua adjudication path as a
//     human bid. Nothing is faked into the Stream; seq/evidence stay exact.
//   - ENGLISH rooms only; sealed/hybrid stay untouched.
//   - A sim bid is always strictly BELOW the cap — the buy-now hammer moment is
//     reserved for humans (or the Timer Worker).
//   - Quiet tail: inside (anti-snipe window + 8s) the sim stops bidding, so it
//     can neither extend the auction forever nor snipe a human at the wire.
//   - Viewer counts/likes ride ROOM_SOCIAL stats frames — non-authoritative,
//     no seq, zero contact with the bid path (V9 P3 intact).
//   - Off switch: LUMEN_DEMO_CROWD=0 server-wide, or per-publish via the
//     `demoCrowd:false` field on POST /api/auctions/{id}/start.

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/rand"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/metrics"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"
	"github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/store"
)

const (
	crowdRampMs       = 40_000 // viewer ramp-in duration
	crowdBaseViewers  = 86     // instantly-present viewers at open
	crowdStatsEvery   = 2500 * time.Millisecond
	crowdQuietExtraMs = 8_000         // quiet tail beyond the anti-snipe window
	crowdMaxLifetime  = 2 * time.Hour // hard stop — a forgotten room can't leak a goroutine forever
)

// crowdNicknames is the sim-bidder identity pool. Real-ish Douyin-style handles;
// upserted once per process so leaderboard rows and (if a sim user ever wins)
// the order row have a real users entry.
var crowdNicknames = []string{
	"北京的马大瓜", "上海的设计狮", "广州的阿强", "杭州的小鹿", "深圳的老王",
	"成都的椒椒", "重庆的山城辣妹", "南京的梧桐", "武汉的热干面", "西安的兵马俑",
	"苏州的园林控", "天津的相声迷", "长沙的茶颜", "青岛的海风", "厦门的鼓浪屿",
	"老表玩收藏", "鉴宝小能手", "捡漏大队长", "理性竞拍人", "出价不眨眼",
	"腕表老饕", "包包鉴赏家", "球鞋研究员", "穿搭顾问Vv", "古着收藏家",
	"直播间常客", "夜猫子买手", "周末淘货王", "精打细算阿姨", "壕气冲天",
	"低调的神秘人", "路过的行家", "懂行的二叔", "凑热闹的小李", "蹲守三小时",
	"志在必得君", "氪金玩家", "冷静分析帝", "一眼真大佬", "看走眼新手",
	"快乐剁手党", "工资刚到账", "下个月吃土", "替媳妇出价", "帮老板举牌",
	"匿名藏家007", "南方收藏协会", "北方拍卖常客",
}

// CrowdSim owns the per-auction crowd scripts. All methods are nil-safe so
// bare Server{} unit-test fixtures don't need wiring.
type CrowdSim struct {
	st            *store.Store
	hub           *Hub
	social        *socialState
	metrics       *metrics.Registry
	broadcast     func(aid string, data model.RoomSocialData)
	defaultOn     bool
	viewersTarget int64
	bidsTarget    int64

	mu       sync.Mutex
	runs     map[string]*crowdRun
	seedOnce sync.Once
	users    []crowdUser
}

type crowdUser struct{ id, nick string }

type crowdRun struct {
	cancel  context.CancelFunc
	viewers atomic.Int64
}

func newCrowdSim(st *store.Store, hub *Hub, social *socialState, m *metrics.Registry, broadcast func(string, model.RoomSocialData)) *CrowdSim {
	return &CrowdSim{
		st:            st,
		hub:           hub,
		social:        social,
		metrics:       m,
		broadcast:     broadcast,
		defaultOn:     envBool("LUMEN_DEMO_CROWD", true),
		viewersTarget: int64(envInt("LUMEN_CROWD_VIEWERS", 9997)),
		bidsTarget:    int64(envInt("LUMEN_CROWD_BIDS", 3992)),
		runs:          make(map[string]*crowdRun),
	}
}

// crowdEnabled merges the per-start override with the env default. Pure.
func crowdEnabled(envDefault bool, override *bool) bool {
	if override != nil {
		return *override
	}
	return envDefault
}

// ViewerBoost is the sim-viewer headcount added on top of real WS occupancy.
// Read by the join-time ROOM_SNAPSHOT and GET /api/auctions/{id}.
func (c *CrowdSim) ViewerBoost(aid string) int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	run := c.runs[aid]
	c.mu.Unlock()
	if run == nil {
		return 0
	}
	return int(run.viewers.Load())
}

// MaybeStart launches the crowd script for a freshly-LIVE auction. Idempotent
// per auction; respects env + per-request override.
func (c *CrowdSim) MaybeStart(aid string, override *bool) {
	if c == nil || aid == "" || !crowdEnabled(c.defaultOn, override) {
		return
	}
	c.mu.Lock()
	if _, exists := c.runs[aid]; exists {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), crowdMaxLifetime)
	run := &crowdRun{cancel: cancel}
	c.runs[aid] = run
	c.mu.Unlock()

	go func() {
		defer recoverGoroutine("crowdsim("+aid+")", c.metrics)
		defer func() {
			cancel()
			c.mu.Lock()
			delete(c.runs, aid)
			c.mu.Unlock()
		}()
		c.loop(ctx, aid, run)
	}()
}

// Stop tears down one auction's script (used on cancel; terminal states also
// self-detect via snapshots).
func (c *CrowdSim) Stop(aid string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	run := c.runs[aid]
	c.mu.Unlock()
	if run != nil {
		run.cancel()
	}
}

func (c *CrowdSim) loop(ctx context.Context, aid string, run *crowdRun) {
	rules, err := c.st.GetRules(ctx, aid)
	if err != nil {
		log.Printf("crowdsim %s: rules unavailable: %v", aid, err)
		return
	}
	if model.NormalizeMode(rules.Mode) != model.ModeEnglish {
		return // sealed/hybrid rooms keep their contract-mandated silence
	}
	users := c.ensureSimUsers(ctx)
	if len(users) == 0 {
		return
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	startMs := time.Now().UnixMilli()
	quietMs := rules.ExtendWindowSec*1000 + crowdQuietExtraMs
	var bidsDone int64
	bidsStopped := false

	stats := time.NewTicker(crowdStatsEvery)
	defer stats.Stop()
	bidTimer := time.NewTimer(1200 * time.Millisecond)
	defer bidTimer.Stop()

	log.Printf("crowdsim %s: started (viewers→%d, bids→%d, quietTail=%dms)", aid, c.viewersTarget, c.bidsTarget, quietMs)
	for {
		select {
		case <-ctx.Done():
			return

		case <-stats.C:
			snap, serr := c.st.Snapshot(ctx, aid)
			if serr != nil {
				continue
			}
			if snap.Status != "" && snap.Status != model.StateLive {
				log.Printf("crowdsim %s: auction %s — crowd script done (%d sim bids)", aid, snap.Status, bidsDone)
				return
			}
			elapsed := time.Now().UnixMilli() - startMs
			v := crowdViewersAt(elapsed, c.viewersTarget, rng)
			run.viewers.Store(v)
			likes := c.social.addLikes(aid, crowdLikesDelta(v, rng))
			if c.broadcast != nil {
				c.broadcast(aid, model.RoomSocialData{
					Kind:         "stats",
					ViewerCount:  int(v) + c.hub.viewerCount(aid),
					LikeCount:    likes,
					ServerTimeMs: time.Now().UnixMilli(),
				})
			}

		case <-bidTimer.C:
			if bidsStopped || bidsDone >= c.bidsTarget {
				bidsStopped = true
				continue // stats keep flowing until terminal
			}
			snap, serr := c.st.Snapshot(ctx, aid)
			if serr != nil || snap.Status != model.StateLive {
				bidTimer.Reset(2 * time.Second)
				continue
			}
			nowMs := time.Now().UnixMilli()
			remaining := snap.EndAtMs - nowMs
			if remaining <= quietMs {
				// Quiet tail: leave the finale to humans + Timer Worker. Bids are
				// done for good (the tail only shrinks), stats continue.
				bidsStopped = true
				log.Printf("crowdsim %s: quiet tail reached — sim bidding stopped at %d bids", aid, bidsDone)
				continue
			}
			cur, _ := strconv.ParseInt(snap.CurrentPriceCents, 10, 64)
			amount, ok := nextCrowdAmount(cur, int64(rules.IncrementCents), int64(rules.CapPriceCents), rng)
			if !ok {
				bidsStopped = true
				log.Printf("crowdsim %s: cap guard — sim bidding stopped at %d bids (humans take it from here)", aid, bidsDone)
				continue
			}
			u := users[rng.Intn(len(users))]
			code, _, _, berr := c.st.PlaceBid(ctx, aid, u.id, fmt.Sprintf("sim-%s-%d", aid, bidsDone), strconv.FormatInt(amount, 10), u.nick)
			if berr == nil && (code == model.CodeOKAccepted || code == model.CodeOKExtended) {
				bidsDone++
			}
			bidTimer.Reset(crowdBidGap(remaining-quietMs, c.bidsTarget-bidsDone, rng))
		}
	}
}

// ensureSimUsers upserts the sim identity pool once per process. Errors are
// logged, not fatal — a partially-seeded pool still works.
func (c *CrowdSim) ensureSimUsers(ctx context.Context) []crowdUser {
	c.seedOnce.Do(func() {
		users := make([]crowdUser, 0, len(crowdNicknames))
		for i, nick := range crowdNicknames {
			id := fmt.Sprintf("user_sim%02d", i+1)
			if err := c.st.UpsertUser(ctx, id, nick, "user"); err != nil {
				log.Printf("crowdsim: upsert %s: %v", id, err)
				continue
			}
			users = append(users, crowdUser{id: id, nick: nick})
		}
		c.users = users
	})
	return c.users
}

// crowdViewersAt is the viewer ramp curve: ease-out cubic from the base crowd
// to the target over crowdRampMs, then a small random walk so the number
// breathes instead of freezing. Pure given an rng.
func crowdViewersAt(elapsedMs, target int64, rng *rand.Rand) int64 {
	if target <= 0 {
		return 0
	}
	base := int64(crowdBaseViewers)
	if base > target {
		base = target
	}
	t := float64(elapsedMs) / float64(crowdRampMs)
	if t > 1 {
		t = 1
	}
	if t < 0 {
		t = 0
	}
	ease := 1 - math.Pow(1-t, 3)
	v := base + int64(float64(target-base)*ease)
	// breathe: ±0.4% of target once ramped, smaller during ramp
	jitter := int64(float64(target) * 0.004 * (rng.Float64()*2 - 1) * t)
	v += jitter
	if v < 0 {
		v = 0
	}
	return v
}

// crowdLikesDelta is the per-stats-tick organic like growth: roughly
// proportional to the live crowd, with jitter. Pure given an rng.
func crowdLikesDelta(viewers int64, rng *rand.Rand) int64 {
	base := viewers / 900
	return base + rng.Int63n(4)
}

// nextCrowdAmount picks the sim's next bid: current + k·step with k weighted
// toward single steps. Returns ok=false when any rule-legal sim bid would
// reach the cap (cap touch == instant SOLD — reserved for humans) or overflow
// MaxMoneyCents. Pure given an rng.
func nextCrowdAmount(currentCents, stepCents, capCents int64, rng *rand.Rand) (int64, bool) {
	if stepCents <= 0 {
		return 0, false
	}
	k := int64(1)
	switch r := rng.Float64(); {
	case r > 0.94:
		k = 3
	case r > 0.78:
		k = 2
	}
	for ; k >= 1; k-- {
		amount := currentCents + k*stepCents
		if amount > int64(model.MaxMoneyCents) {
			continue
		}
		if capCents > 0 && amount >= capCents {
			continue // would buy-now-settle the room — never from a bot
		}
		return amount, true
	}
	return 0, false
}

// crowdBidGap paces the remaining bid budget across the remaining active
// window (excluding the quiet tail), clamped to a human-plausible rhythm.
// Pure given an rng.
func crowdBidGap(activeRemainingMs, bidsLeft int64, rng *rand.Rand) time.Duration {
	if bidsLeft < 1 {
		bidsLeft = 1
	}
	if activeRemainingMs < 0 {
		activeRemainingMs = 0
	}
	mean := float64(activeRemainingMs) / float64(bidsLeft+1)
	jittered := mean * (0.5 + rng.Float64()*1.1) // ×[0.5, 1.6)
	const minGap, maxGap = 200, 5000
	if jittered < minGap {
		jittered = minGap
	}
	if jittered > maxGap {
		jittered = maxGap
	}
	return time.Duration(jittered) * time.Millisecond
}
