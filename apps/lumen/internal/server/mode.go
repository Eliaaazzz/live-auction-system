package server

import "github.com/Eliaaazzz/live-auction-system/apps/lumen/internal/model"

// AuctionMode is the strategy for one auction format (issue #114). It owns the
// per-mode policy the gateway/store need. In Phase 0/1 that is just rule
// normalization at creation time; later phases extend this interface with Lua
// place-bid / close script selection and the broadcast-redaction policy. Modes
// are stateless singletons looked up by name via modeFor.
type AuctionMode interface {
	Name() string
	// NormalizeRules applies mode-specific rule adjustments at creation time
	// (e.g. Sudden Death disables anti-snipe). It must preserve r.Mode.
	NormalizeRules(model.Rules) model.Rules
	// SealedDuringLive reports whether bids are hidden from the room while LIVE
	// (no live price / leaderboard; reveal at close).
	SealedDuringLive() bool
}

// baseMode is the ENGLISH default: ascending + anti-snipe, nothing redacted.
type baseMode struct{ name string }

func (m baseMode) Name() string                             { return m.name }
func (m baseMode) NormalizeRules(r model.Rules) model.Rules { return boundAntiSnipe(r) }
func (m baseMode) SealedDuringLive() bool                   { return false }

// antiSnipeMaxExtensionsDefault bounds a misconfigured anti-snipe auction's
// lifetime. The spec's "自动延时 …10-30 秒" implies a FINITE cap, but the engine
// treats MaxExtensions==0 as *unlimited* — so two bidders bouncing the price
// inside the window could push endAtMs forever. This is the conservative cap we
// inject when the seller left it open.
const antiSnipeMaxExtensionsDefault = 10

// boundAntiSnipe closes the "infinite extension" hole (spec deep-review, rule 4):
// when anti-snipe is ON (extendWindowSec>0 && extendSec>0) but MaxExtensions was
// left at 0 (=unlimited), inject a finite default so the auction must end. No-op
// when anti-snipe is off or a finite cap is already set, so it never shrinks an
// explicit operator choice.
func boundAntiSnipe(r model.Rules) model.Rules {
	if r.ExtendWindowSec > 0 && r.ExtendSec > 0 && r.MaxExtensions <= 0 {
		r.MaxExtensions = antiSnipeMaxExtensionsDefault
	}
	return r
}

// suddenDeathMode is ENGLISH with anti-snipe OFF (Whatnot "Sudden Death"): the
// clock never extends, so a late bid can't reopen the countdown. We disable
// extension by zeroing the window/seconds — NOT MaxExtensions, since
// MaxExtensions==0 means *unlimited* (place_bid.lua extends only when
// extendWindowSec>0 && extendSec>0). Reuses place_bid.lua / close_auction.lua
// unchanged — no new engine code.
type suddenDeathMode struct{ baseMode }

func (m suddenDeathMode) NormalizeRules(r model.Rules) model.Rules {
	r.ExtendWindowSec = 0
	r.ExtendSec = 0
	r.MaxExtensions = 0
	return r
}

// sealedMode marks formats whose bids are hidden during LIVE. The engine
// behavior (private store + redacted broadcast + reveal-at-close) is wired in
// later phases; for now it carries the SealedDuringLive policy so gateway/REST
// gating and the static room UI can branch on it.
type sealedMode struct{ baseMode }

func (m sealedMode) SealedDuringLive() bool { return true }

// modeRegistry holds the ENABLED auction modes. A mode that is a valid contract
// value (model.ValidMode) but absent here is not yet runnable —
// handleCreateAuction rejects it as "not available yet". Add an entry as each
// phase lands (HYBRID_REVEAL, ALL_PAY, PREQUALIFY are reserved but unbuilt).
var modeRegistry = map[string]AuctionMode{
	model.ModeEnglish:      baseMode{model.ModeEnglish},
	model.ModeSuddenDeath:  suddenDeathMode{baseMode{model.ModeSuddenDeath}},
	model.ModeSealedFirst:  sealedMode{baseMode{model.ModeSealedFirst}},
	model.ModeVickrey:      sealedMode{baseMode{model.ModeVickrey}},
	model.ModeHybridReveal: baseMode{model.ModeHybridReveal},       // ascending engine; redacted broadcast (issue #114)
	model.ModeAllPay:       sealedMode{baseMode{model.ModeAllPay}}, // sealed bid path + coin-ledger settlement (issue #114)
}

// modeFor returns the strategy for an enabled mode. ok=false means the mode is a
// valid contract value but not yet runnable, so the caller should reject it.
func modeFor(name string) (AuctionMode, bool) {
	m, ok := modeRegistry[model.NormalizeMode(name)]
	return m, ok
}
