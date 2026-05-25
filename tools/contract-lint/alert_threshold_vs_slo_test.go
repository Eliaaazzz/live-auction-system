// PR #18 contract test — every latency SLO must have at least one alert that
// fires within SLO×1.5. PDGGK's PR #18 re-review (P0-3) caught alert thresholds
// at floor only (2.5–3.3× SLO), which makes the alerts effectively useless as
// early warnings. This test prevents regression: anyone tightening or removing
// the warn-tier alerts will hit this gate.
//
// The SLOs come from V9 §4.2 and are duplicated here as constants because the
// SLO doc is in prose (no machine-readable form yet); this test is the de-facto
// SLO contract until that exists.
package contractlint

import (
	"strconv"
	"strings"
	"testing"
)

var sloMaxAlertThreshold = []struct {
	metric        string  // unique substring that identifies the alert rule expr
	slo           float64 // SLO p95 in seconds
	maxWarnFactor float64 // warn must fire at or below SLO×maxWarnFactor
}{
	{metric: "lumen_bidengine_ack_duration_seconds_bucket", slo: 0.080, maxWarnFactor: 1.5},
	{metric: "lumen_bidengine_broadcast_duration_seconds_bucket", slo: 0.150, maxWarnFactor: 1.5},
	{metric: "lumen_bidengine_hammer_duration_seconds_bucket", slo: 0.500, maxWarnFactor: 1.5},
}

// TestAlertThresholdsHaveSLOTierWarning asserts that for each SLO metric the
// alerts.yml contains at least one rule whose threshold is ≤ SLO×maxWarnFactor.
// Parser is intentionally simple: a metric is "alerted within bounds" if any
// line containing the metric name is followed (within 8 lines) by an expr that
// contains a comparison ` > X` where X ≤ SLO×factor.
func TestAlertThresholdsHaveSLOTierWarning(t *testing.T) {
	alerts := readDoc(t, "infra/prometheus/alerts.yml")
	for _, c := range sloMaxAlertThreshold {
		max := c.slo * c.maxWarnFactor
		if !alertWithinThreshold(alerts, c.metric, max) {
			t.Errorf("alerts.yml: no warn-tier alert on %q within SLO×%.2f = %.3fs — only floor alerts exist (PDGGK CR P0-3)",
				c.metric, c.maxWarnFactor, max)
		}
	}
}

func alertWithinThreshold(alerts, metric string, max float64) bool {
	lines := strings.Split(alerts, "\n")
	for i, l := range lines {
		if !strings.Contains(l, metric) {
			continue
		}
		end := i + 8
		if end > len(lines) {
			end = len(lines)
		}
		for j := i; j < end; j++ {
			if n, ok := parseGreaterThan(lines[j]); ok && n <= max+1e-9 {
				return true
			}
		}
	}
	return false
}

func parseGreaterThan(line string) (float64, bool) {
	idx := strings.Index(line, ">")
	if idx < 0 {
		return 0, false
	}
	rest := strings.TrimSpace(line[idx+1:])
	if c := strings.Index(rest, "#"); c >= 0 {
		rest = strings.TrimSpace(rest[:c])
	}
	end := 0
	for end < len(rest) {
		c := rest[end]
		if (c >= '0' && c <= '9') || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+' {
			end++
			continue
		}
		break
	}
	if end == 0 {
		return 0, false
	}
	f, err := strconv.ParseFloat(rest[:end], 64)
	if err != nil {
		return 0, false
	}
	return f, true
}
