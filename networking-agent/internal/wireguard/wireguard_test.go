package wireguard

import (
	"context"
	"errors"
	"testing"
)

const keyA = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
const keyB = "TrMvSoP4jYQlY6RIzBgbssQqY3vxI2Pi+y71lOWWXX0="

func TestValidateDesiredSafetyEnvelope(t *testing.T) {
	ok := DesiredConfig{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"10.42.0.2/32"}, Endpoint: "192.168.1.5:51820"}}}
	if err := ValidateDesired(ok); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := []DesiredConfig{
		{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"0.0.0.0/0"}}}},       // default route hijack
		{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"10.42.0.0/24"}}}},    // whole subnet
		{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"192.168.1.10/32"}}}}, // outside network
		{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, Endpoint: "evil.example.com:51820"}}},      // DNS endpoint
		{NetworkCIDR: "10.42.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA}, {PublicKey: keyA}}},                       // duplicate
		{NetworkCIDR: "nonsense", Peers: nil},
	}
	for i, c := range bad {
		if err := ValidateDesired(c); err == nil {
			t.Errorf("case %d: unsafe config accepted", i)
		}
	}
	_ = keyB
}

func TestApplierDisabledByDefault(t *testing.T) {
	var zero [32]byte
	a := NewApplier(false, zero)
	if a.Enabled() {
		t.Fatal("applier must be disabled without privileged mode")
	}
	if err := a.Apply(context.Background(), "nexlink0", DesiredConfig{}); !errors.Is(err, ErrPrivilegedDisabled) {
		t.Fatalf("expected ErrPrivilegedDisabled, got %v", err)
	}
}
