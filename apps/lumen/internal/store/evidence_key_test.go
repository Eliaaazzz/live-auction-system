package store

import "testing"

func TestStaticEvidenceKeySourceDefaultsToVersionOne(t *testing.T) {
	src := NewStaticEvidenceKeySource("test-key")
	version, key, err := src.CurrentEvidenceKey()
	if err != nil {
		t.Fatal(err)
	}
	if version != 1 {
		t.Fatalf("version=%d want 1", version)
	}
	if string(key) != "test-key" {
		t.Fatalf("key=%q want test-key", string(key))
	}
}

func TestStaticEvidenceKeySourceReturnsCopies(t *testing.T) {
	src := NewStaticEvidenceKeySource("test-key")
	_, key, err := src.CurrentEvidenceKey()
	if err != nil {
		t.Fatal(err)
	}
	key[0] = 'X'

	_, again, err := src.CurrentEvidenceKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != "test-key" {
		t.Fatalf("source key mutated through returned slice: %q", string(again))
	}
}

func TestStaticEvidenceKeySourceRejectsMissingVersion(t *testing.T) {
	src := NewStaticEvidenceKeySource("test-key")
	if _, err := src.EvidenceKey(2); err == nil {
		t.Fatal("EvidenceKey(2) succeeded; want unavailable version error")
	}
}

func TestStaticEvidenceKeySourceRejectsEmptyKey(t *testing.T) {
	src := NewStaticEvidenceKeySource("")
	if _, _, err := src.CurrentEvidenceKey(); err == nil {
		t.Fatal("empty evidence key accepted")
	}
}
