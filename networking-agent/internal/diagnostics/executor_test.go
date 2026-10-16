package diagnostics

import (
	"net"
	"testing"
)

func subnet(s string) *net.IPNet {
	_, n, _ := net.ParseCIDR(s)
	return n
}

func TestPickEndpointPrefersSameLAN(t *testing.T) {
	cands := []EndpointCandidate{
		{Endpoint: "172.24.16.1:51820", Kind: "host_reported"}, // e.g. a Hyper-V virtual switch
		{Endpoint: "192.168.1.20:51820", Kind: "host_reported"},
		{Endpoint: "203.0.113.9:51820", Kind: "reflexive_guess"},
	}
	if got := PickEndpoint(cands, []*net.IPNet{subnet("192.168.1.0/24")}); got != "192.168.1.20:51820" {
		t.Fatalf("got %s", got)
	}
	// Different LAN → reflexive guess beats an arbitrary host address.
	if got := PickEndpoint(cands, []*net.IPNet{subnet("10.0.0.0/24")}); got != "203.0.113.9:51820" {
		t.Fatalf("got %s", got)
	}
	if got := PickEndpoint([]EndpointCandidate{{Endpoint: "host.example:51820"}}, nil); got != "" {
		t.Fatalf("DNS names must be ignored, got %s", got)
	}
	if got := PickEndpoint(nil, nil); got != "" {
		t.Fatal("expected empty")
	}
}
