// Package platform collects read-only host network facts.
package platform

import (
	"net"
	"regexp"
	"sort"
	"strconv"
)

// LocalSubnets returns the IPv4 subnets of up, non-loopback interfaces
// (excluding the tunnel). Used to prefer a peer endpoint on the same LAN.
func LocalSubnets(tunnelIface string) []*net.IPNet {
	var out []*net.IPNet
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || ifc.Name == tunnelIface {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLinkLocalUnicast() {
				out = append(out, ipn)
			}
		}
	}
	return out
}

// Names of other VPN / overlay / virtual adapters. Their addresses are still
// offered, but last: peers on the same physical LAN should dial the LAN IP.
var overlayName = regexp.MustCompile(`(?i)tailscale|zerotier|radmin|hamachi|wireguard|nexlink|openvpn|tap-|tun|vpn|vethernet|hyper-v|vmware|virtualbox|docker|wsl`)

var cgnat = func() *net.IPNet { _, n, _ := net.ParseCIDR("100.64.0.0/10"); return n }()

// CandidateRank orders endpoint candidates: 0 = private LAN (RFC 1918) on a
// physical adapter, 1 = other address on a physical adapter, 2 = CGNAT,
// 3 = known overlay/virtual adapter. Lower is tried first.
func CandidateRank(ifaceName string, ip net.IP) int {
	switch {
	case overlayName.MatchString(ifaceName):
		return 3
	case cgnat.Contains(ip):
		return 2
	case ip.IsPrivate():
		return 0
	default:
		return 1
	}
}

// EndpointCandidates lists host-local IPv4 addresses of up, non-loopback
// interfaces joined with the WireGuard listen port, best candidate first.
// These are candidates a peer *might* reach; behind NAT none of them may be
// reachable from outside. The tunnel interface itself is excluded.
func EndpointCandidates(listenPort int, tunnelIface string) []string {
	out := []string{}
	if listenPort <= 0 {
		return out
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	type cand struct {
		ep   string
		rank int
	}
	var cs []cand
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || ifc.Name == tunnelIface {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			cs = append(cs, cand{net.JoinHostPort(ipn.IP.String(), strconv.Itoa(listenPort)), CandidateRank(ifc.Name, ipn.IP)})
		}
	}
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].rank < cs[j].rank })
	for _, c := range cs {
		out = append(out, c.ep)
		if len(out) >= 8 {
			break
		}
	}
	return out
}
