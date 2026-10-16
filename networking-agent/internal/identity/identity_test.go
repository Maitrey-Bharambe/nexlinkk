package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

func TestKeysPersistAndAreNotRegenerated(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if a.PublicKey() != b.PublicKey() || a.WireGuardPublicKey() != b.WireGuardPublicKey() {
		t.Fatal("keys changed across loads")
	}
	if a.PublicKey() == a.WireGuardPublicKey() {
		t.Fatal("identity and tunnel keys must be independent")
	}
	if a.Enrolled() {
		t.Fatal("fresh identity must not be enrolled")
	}
	a.State.DeviceID = "0123456789abcdef01234567"
	if err := a.SaveState(); err != nil {
		t.Fatal(err)
	}
	c, _ := LoadOrCreate(dir)
	if c.State.DeviceID != a.State.DeviceID {
		t.Fatal("state not persisted")
	}
}

func TestSignatureVerifies(t *testing.T) {
	id, _ := LoadOrCreate(t.TempDir())
	pub, _ := base64.StdEncoding.DecodeString(id.PublicKey())
	sig, _ := base64.StdEncoding.DecodeString(id.Sign([]byte("hello")))
	if !ed25519.Verify(pub, []byte("hello"), sig) {
		t.Fatal("signature does not verify")
	}
}
