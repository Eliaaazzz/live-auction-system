package invariants

import (
	"context"
	"fmt"
	"strings"
)

// DegradeExpected — for phases that *should* produce specific wire codes
// during the drill window. Only added by For() when the phase's
// ExpectedDegradeWireCodes() is non-empty.
//
// Example: redis phase expects to see ≥1 ERR_AUCTION_PAUSED during the drill.
// If we never see any, either the fault didn't actually inject, or the
// engine isn't honoring the frozen ERR_AUCTION_PAUSED boundary.
type DegradeExpected struct {
	env         Env
	expectCodes []string
}

func NewDegradeExpected(env Env, codes ...string) Invariant {
	return &DegradeExpected{env: env, expectCodes: codes}
}

func (d *DegradeExpected) Name() string { return "degrade_expected_codes_seen" }
func (d *DegradeExpected) Description() string {
	return fmt.Sprintf("during-drill bid attempts must include at least one of: %s", strings.Join(d.expectCodes, ", "))
}

func (d *DegradeExpected) Check(ctx context.Context) Result {
	for _, code := range d.expectCodes {
		count, _ := ctx.Value(eventCountKey(d.env.DuringEventsKey, "BID_REJECTED::"+code)).(int)
		if count > 0 {
			return Pass(d, fmt.Sprintf("observed %d × %s during drill window", count, code))
		}
	}
	return Fail(d, "no expected degrade codes observed (%s) — fault may not have actually injected", strings.Join(d.expectCodes, "|"))
}
