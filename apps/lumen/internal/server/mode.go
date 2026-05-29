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
func (m baseMode) NormalizeRules(r model.Rules) model.Rules { return r }
func (m baseMode) SealedDuringLive() bool                   { return false }

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

var modeRegistry = map[string]AuctionMode{
	model.ModeEnglish:      baseMode{model.ModeEnglish},
	model.ModeSuddenDeath:  suddenDeathMode{baseMode{model.ModeSuddenDeath}},
	model.ModeSealedFirst:  sealedMode{baseMode{model.ModeSealedFirst}},
	model.ModeVickrey:      sealedMode{baseMode{model.ModeVickrey}},
	model.ModeHybridReveal: baseMode{model.ModeHybridReveal}, // ascending; redaction wired in Phase 4
	model.ModeAllPay:       sealedMode{baseMode{model.ModeAllPay}},
	model.ModePrequalify:   sealedMode{baseMode{model.ModePrequalify}},
}

// modeFor returns the strategy for a mode name, defaulting to ENGLISH for the
// empty string or any unknown value (Validate already rejects unknown modes at
// the REST boundary, so this is a safe fallback).
func modeFor(name string) AuctionMode {
	if m, ok := modeRegistry[model.NormalizeMode(name)]; ok {
		return m
	}
	return modeRegistry[model.ModeEnglish]
}
