package store

import "testing"

type testEvidenceKeyRing map[int][]byte

func (r testEvidenceKeyRing) CurrentEvidenceKey() (int, []byte, error) {
	return 2, cloneEvidenceKey(r[2]), nil
}

func (r testEvidenceKeyRing) EvidenceKey(version int) ([]byte, error) {
	key, ok := r[version]
	if !ok {
		return nil, errTestEvidenceKeyMissing
	}
	return cloneEvidenceKey(key), nil
}

type testEvidenceKeyMissingError struct{}

func (testEvidenceKeyMissingError) Error() string { return "test evidence key missing" }

var errTestEvidenceKeyMissing = testEvidenceKeyMissingError{}

func TestEvidenceHashForVersionUsesRowKeyVersion(t *testing.T) {
	src := testEvidenceKeyRing{
		1: []byte("old-key"),
		2: []byte("new-key"),
	}
	st := &Store{evidenceKeySource: src}

	h1, err := st.evidenceHashForVersion(1, "", 1, "BID_ACCEPTED", `{"amountCents":"100"}`)
	if err != nil {
		t.Fatalf("evidenceHashForVersion(1): %v", err)
	}
	h2, err := st.evidenceHashForVersion(2, "", 1, "BID_ACCEPTED", `{"amountCents":"100"}`)
	if err != nil {
		t.Fatalf("evidenceHashForVersion(2): %v", err)
	}
	if h1 == h2 {
		t.Fatal("versioned evidence hashes matched; want distinct hashes for distinct keys")
	}
	wantV1 := evidenceHashWithKey([]byte("old-key"), "", 1, "BID_ACCEPTED", `{"amountCents":"100"}`)
	wantV2 := evidenceHashWithKey([]byte("new-key"), "", 1, "BID_ACCEPTED", `{"amountCents":"100"}`)
	if h1 != wantV1 {
		t.Fatalf("version 1 hash = %s, want %s", h1, wantV1)
	}
	if h2 != wantV2 {
		t.Fatalf("version 2 hash = %s, want %s", h2, wantV2)
	}
}

func TestEvidenceHashForVersionRejectsUnavailableKeyVersion(t *testing.T) {
	st := &Store{evidenceKeySource: testEvidenceKeyRing{1: []byte("old-key")}}
	if _, err := st.evidenceHashForVersion(2, "", 1, "BID_ACCEPTED", `{}`); err == nil {
		t.Fatal("evidenceHashForVersion(2) succeeded with unavailable key; want error")
	}
}
