package server

import "testing"

// Hidden tests for the multi-gateway room-affinity decision. The landmine
// (roadmap): a gateway that filters rooms by local membership MUST seed its
// broadcast cursor exactly once, on the FIRST time it hosts a room — otherwise
// it either replays the entire stream (seed missing) or, if it never reads
// non-hosted rooms, silently drops them. gatewayHostsRoom encodes that contract.
func TestGatewayHostsRoom(t *testing.T) {
	cases := []struct {
		name         string
		localViewers int
		seeded       bool
		wantProcess  bool
		wantSeed     bool
	}{
		{"no local members -> skip (hosted elsewhere)", 0, false, false, false},
		{"no local members, even if previously seeded -> skip", 0, true, false, false},
		{"first time hosting -> process AND seed cursor", 5, false, true, true},
		{"already hosting -> process, do NOT re-seed", 5, true, true, false},
		{"single local member, fresh -> process AND seed", 1, false, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			process, seed := gatewayHostsRoom(tc.localViewers, tc.seeded)
			if process != tc.wantProcess || seed != tc.wantSeed {
				t.Fatalf("gatewayHostsRoom(viewers=%d, seeded=%v) = (process=%v, seed=%v), want (%v, %v)",
					tc.localViewers, tc.seeded, process, seed, tc.wantProcess, tc.wantSeed)
			}
		})
	}
}

// TestGatewayRoomAffinityDefaultOff pins that the feature is inert by default —
// the single-process demo (mode=all) must keep today's broadcast behaviour.
func TestGatewayRoomAffinityDefaultOff(t *testing.T) {
	if gatewayRoomAffinity {
		t.Fatal("gatewayRoomAffinity must default to false (GATEWAY_ROOM_AFFINITY unset) so single-gateway behaviour is unchanged")
	}
}
