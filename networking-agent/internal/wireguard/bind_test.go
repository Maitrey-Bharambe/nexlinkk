package wireguard

import (
	"context"
	"encoding/hex"
	"io"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"

	"github.com/nexlink/networking-agent/internal/relay"
)

// memRelay is an in-memory stand-in for the control plane relay: it delivers
// a frame to the device it names and stamps the sender's id, like the server.
type memRelay struct {
	self  [relay.IDLen]byte
	peers map[[relay.IDLen]byte]*memRelay
	in    chan relay.Packet
	seen  int
}

func (m *memRelay) Send(peer [relay.IDLen]byte, data []byte) error {
	m.seen++
	if dst, ok := m.peers[peer]; ok {
		dst.in <- relay.Packet{Peer: m.self, Data: append([]byte(nil), data...)}
	}
	return nil
}

func (m *memRelay) Incoming() <-chan relay.Packet { return m.in }

func mustID(t *testing.T, s string) [relay.IDLen]byte {
	id, err := relay.ParseID(s)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// Category: real WireGuard protocol between two wireguard-go devices whose
// only path is the relay (no UDP endpoint configured). Proves the handshake
// and encrypted TCP traffic work through "relay:<id>" endpoints.
func TestRelayOnlyTunnel(t *testing.T) {
	idA, idB := "65f000000000000000000001", "65f000000000000000000002"
	peers := map[[relay.IDLen]byte]*memRelay{}
	ra := &memRelay{self: mustID(t, idA), peers: peers, in: make(chan relay.Packet, 256)}
	rb := &memRelay{self: mustID(t, idB), peers: peers, in: make(chan relay.Packet, 256)}
	peers[ra.self], peers[rb.self] = ra, rb

	ka, _ := wgtypes.GeneratePrivateKey()
	kb, _ := wgtypes.GeneratePrivateKey()
	ipA, ipB := netip.MustParseAddr("10.124.0.2"), netip.MustParseAddr("10.124.0.3")
	a, err := NewUserspaceDeviceWithBind("relay-a", ka, ipA, freeUDPPort(t), NewMuxBind(ra))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := NewUserspaceDeviceWithBind("relay-b", kb, ipB, freeUDPPort(t), NewMuxBind(rb))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	cfg := func(peer wgtypes.Key, ip netip.Addr, endpoint string) DesiredConfig {
		return DesiredConfig{NetworkCIDR: "10.124.0.0/24", Peers: []DesiredPeer{{
			PublicKey: peer.PublicKey().String(), AllowedIPs: []string{ip.String() + "/32"},
			Endpoint: endpoint, PersistentKeepalive: 25 * time.Second,
		}}}
	}
	// A knows to use the relay; B has no endpoint at all and learns A's
	// relay endpoint from the authenticated handshake (WireGuard roaming).
	if err := a.SetPeers(cfg(kb, ipB, RelayPrefix+idB)); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPeers(cfg(ka, ipA, "")); err != nil {
		t.Fatal(err)
	}

	ln, err := b.Net.ListenTCPAddrPort(netip.AddrPortFrom(ipB, 3389))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_, _ = io.Copy(c, c)
			c.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := a.Net.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(ipB, 3389))
	if err != nil {
		t.Fatalf("dial through relay: %v", err)
	}
	msg := []byte("remote desktop bytes, relayed but encrypted")
	_, _ = c.Write(msg)
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(c, got); err != nil || string(got) != string(msg) {
		t.Fatalf("echo failed: %q %v", got, err)
	}
	c.Close()

	if ra.seen == 0 || rb.seen == 0 {
		t.Fatalf("traffic did not use the relay (a sent %d, b sent %d)", ra.seen, rb.seen)
	}
	st := b.Inspect(ctx, "")
	if len(st.Peers) != 1 || st.Peers[0].Endpoint != RelayPrefix+idA || st.Peers[0].LastHandshake.IsZero() {
		t.Fatalf("b should have roamed to a's relay endpoint with a handshake: %+v", st.Peers)
	}
}

func TestRelayEndpointValidation(t *testing.T) {
	ok := DesiredConfig{NetworkCIDR: "10.1.0.0/24", Peers: []DesiredPeer{{PublicKey: "k", AllowedIPs: []string{"10.1.0.2/32"}, Endpoint: "relay:" + hex.EncodeToString(make([]byte, 12))}}}
	if err := ValidateDesired(ok); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"relay:xyz", "relay:", "example.com:51820"} {
		c := ok
		c.Peers = []DesiredPeer{{PublicKey: "k", AllowedIPs: []string{"10.1.0.2/32"}, Endpoint: bad}}
		if ValidateDesired(c) == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
