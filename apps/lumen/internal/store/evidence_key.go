package store

import "fmt"

const defaultEvidenceKeyVersion = 1

// EvidenceKeySource supplies HMAC keys for the auction_events hash chain.
// The current production source is still env-backed, but keeping Store behind
// this interface means a future KMS or versioned key-ring implementation can be
// wired without changing callers or evidence verification code paths again.
type EvidenceKeySource interface {
	CurrentEvidenceKey() (version int, key []byte, err error)
	EvidenceKey(version int) ([]byte, error)
}

// StaticEvidenceKeySource is the env/config backed implementation used today.
// Version defaults to 1 to match existing auction_events rows and the current
// proto contract; future hmac_key_version rows can select older keys through
// EvidenceKey(version).
type StaticEvidenceKeySource struct {
	Version int
	Key     []byte
}

func NewStaticEvidenceKeySource(key string) StaticEvidenceKeySource {
	return StaticEvidenceKeySource{Version: defaultEvidenceKeyVersion, Key: []byte(key)}
}

func (s StaticEvidenceKeySource) CurrentEvidenceKey() (int, []byte, error) {
	version := s.Version
	if version == 0 {
		version = defaultEvidenceKeyVersion
	}
	if version < 0 {
		return 0, nil, fmt.Errorf("evidence key version must be positive: %d", version)
	}
	if len(s.Key) == 0 {
		return 0, nil, fmt.Errorf("evidence key is empty")
	}
	return version, cloneEvidenceKey(s.Key), nil
}

func (s StaticEvidenceKeySource) EvidenceKey(version int) ([]byte, error) {
	currentVersion, key, err := s.CurrentEvidenceKey()
	if err != nil {
		return nil, err
	}
	if version == 0 {
		version = defaultEvidenceKeyVersion
	}
	if version != currentVersion {
		return nil, fmt.Errorf("evidence key version %d unavailable", version)
	}
	return key, nil
}

func cloneEvidenceKey(key []byte) []byte {
	out := make([]byte, len(key))
	copy(out, key)
	return out
}
