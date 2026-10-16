package platform

import (
	"net"
	"testing"
)

func TestCandidateRankPrefersPhysicalLAN(t *testing.T) {
	cases := []struct {
		iface string
		ip    string
		want  int
	}{
		{"Wi-Fi", "192.168.0.105", 0},
		{"Ethernet", "10.0.0.7", 0},
		{"Ethernet", "203.0.113.4", 1},
		{"Ethernet", "100.82.1.1", 2},
		{"Tailscale", "100.82.111.46", 3},
		{"Radmin VPN", "26.186.41.104", 3},
		{"vEthernet (WSL)", "172.24.16.1", 3},
	}
	for _, c := range cases {
		if got := CandidateRank(c.iface, net.ParseIP(c.ip)); got != c.want {
			t.Errorf("%s %s: rank %d, want %d", c.iface, c.ip, got, c.want)
		}
	}
}
