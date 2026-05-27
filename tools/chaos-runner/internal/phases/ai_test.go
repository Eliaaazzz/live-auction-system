package phases

import (
	"testing"
)

func TestAIPhase_Identity(t *testing.T) {
	p, err := Lookup("ai")
	if err != nil {
		t.Fatalf("Lookup(ai) returned err: %v", err)
	}
	if p.Name() != "ai" {
		t.Errorf("Name = %q, want %q", p.Name(), "ai")
	}
	if p.Kind() != "process_kill" {
		t.Errorf("Kind = %q, want %q", p.Kind(), "process_kill")
	}
}

func TestAIPhase_NoExpectedDegradeWireCodes(t *testing.T) {
	// AI is non-authoritative per V9 §0; bidding must NOT degrade during AI
	// outage. If a future change adds an expected code here, that's a frozen
	// contract break — flag it.
	p, _ := Lookup("ai")
	codes := p.ExpectedDegradeWireCodes()
	if len(codes) != 0 {
		t.Errorf("AI phase declared expected-degrade codes %v; per V9 §0 must be empty (bidding unaffected)", codes)
	}
}

func TestAIPhase_RecoveryDeadlineParseable(t *testing.T) {
	p, _ := Lookup("ai")
	d := p.RecoveryDeadline()
	if d != "30s" {
		t.Errorf("RecoveryDeadline = %q, want %q (AI sidecar restart should be quick)", d, "30s")
	}
}

func TestLookup_KnownButNotImplementedReturnsSentinel(t *testing.T) {
	for _, name := range []string{"redis", "mysql", "ws", "timer", "slowclient", "schrodinger", "tamper"} {
		t.Run(name, func(t *testing.T) {
			_, err := Lookup(name)
			if err == nil {
				t.Fatalf("Lookup(%q) returned nil err; expected ErrNotImplemented", name)
			}
			if !isNotImplemented(err) {
				t.Errorf("Lookup(%q) returned %v; expected ErrNotImplemented wrapping", name, err)
			}
		})
	}
}

func TestLookup_UnknownPhase(t *testing.T) {
	_, err := Lookup("bogus")
	if err == nil {
		t.Fatal("Lookup(bogus) returned nil err")
	}
	if isNotImplemented(err) {
		t.Errorf("Lookup(bogus) returned NotImplemented; expected unknown-phase error")
	}
}

func TestAllNames_IncludesStandardPlusDiversified(t *testing.T) {
	names := AllNames()
	wantStandard := []string{"ai", "redis", "mysql", "ws", "timer"}
	wantDiverse := []string{"slowclient", "schrodinger", "tamper"}
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	for _, n := range wantStandard {
		if !got[n] {
			t.Errorf("AllNames() missing standard phase %q", n)
		}
	}
	for _, n := range wantDiverse {
		if !got[n] {
			t.Errorf("AllNames() missing diversified phase %q", n)
		}
	}
}

func isNotImplemented(err error) bool {
	// errors.Is(err, ErrNotImplemented) would be cleaner but the sentinel is
	// wrapped with fmt.Errorf in Lookup which doesn't use %w in all branches.
	// Easier check: error message contains the sentinel's text.
	if err == nil {
		return false
	}
	return contains(err.Error(), ErrNotImplemented.Error())
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
