package wireguard

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Category: real WireGuard protocol between two wireguard-go devices on
// loopback UDP (no OS adapters). Proves handshake + encrypted TCP transfer.
func TestUserspaceTunnelHandshakeAndTraffic(t *testing.T) {
	ka, _ := wgtypes.GeneratePrivateKey()
	kb, _ := wgtypes.GeneratePrivateKey()
	ipA, ipB := netip.MustParseAddr("10.123.0.2"), netip.MustParseAddr("10.123.0.3")
	portA, portB := freeUDPPort(t), freeUDPPort(t)

	a, err := NewUserspaceDevice("lab-a", ka, ipA, portA)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := NewUserspaceDevice("lab-b", kb, ipB, portB)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	cfg := func(peer wgtypes.Key, ip netip.Addr, port int) DesiredConfig {
		return DesiredConfig{NetworkCIDR: "10.123.0.0/24", Peers: []DesiredPeer{{
			PublicKey: peer.PublicKey().String(), AllowedIPs: []string{ip.String() + "/32"},
			Endpoint: fmt.Sprintf("127.0.0.1:%d", port), PersistentKeepalive: 25 * time.Second,
		}}}
	}
	if err := a.SetPeers(cfg(kb, ipB, portB)); err != nil {
		t.Fatal(err)
	}
	if err := b.SetPeers(cfg(ka, ipA, portA)); err != nil {
		t.Fatal(err)
	}

	ln, err := b.Net.ListenTCPAddrPort(netip.AddrPortFrom(ipB, 7946))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_, _ = io.Copy(c, c) // echo
			c.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := a.Net.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(ipB, 7946))
	if err != nil {
		t.Fatalf("dial across tunnel: %v", err)
	}
	msg := []byte("hello over wireguard")
	_, _ = c.Write(msg)
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(c, got); err != nil || string(got) != string(msg) {
		t.Fatalf("echo failed: %q %v", got, err)
	}
	c.Close()

	st := a.Inspect(ctx, "")
	if st.Source != SourceUserspace || st.State != StateUp || st.ListenPort != portA {
		t.Fatalf("status %+v", st)
	}
	if st.PublicKey != ka.PublicKey().String() {
		t.Fatal("interface key not derived correctly")
	}
	if len(st.Peers) != 1 || st.Peers[0].PublicKey != kb.PublicKey().String() {
		t.Fatalf("peers %+v", st.Peers)
	}
	p := st.Peers[0]
	if p.LastHandshake.IsZero() || time.Since(p.LastHandshake) > time.Minute {
		t.Fatalf("no fresh handshake recorded: %v", p.LastHandshake)
	}
	if p.TxBytes == 0 || p.RxBytes == 0 || p.AllowedIPs[0] != ipB.String()+"/32" {
		t.Fatalf("peer counters/allowed ips wrong: %+v", p)
	}
}

func TestUserspaceSetPeersEnforcesSafetyEnvelope(t *testing.T) {
	k, _ := wgtypes.GeneratePrivateKey()
	d, err := NewUserspaceDevice("lab", k, netip.MustParseAddr("10.124.0.2"), freeUDPPort(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	bad := DesiredConfig{NetworkCIDR: "10.124.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"0.0.0.0/0"}}}}
	if err := d.SetPeers(bad); err == nil {
		t.Fatal("default route accepted")
	}
}

func freeUDPPort(t *testing.T) int {
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func TestSyncPeersKeepsSessionsAndRemovesStalePeers(t *testing.T) {
	ka, _ := wgtypes.GeneratePrivateKey()
	kb, _ := wgtypes.GeneratePrivateKey()
	kc, _ := wgtypes.GeneratePrivateKey()
	d, err := NewUserspaceDevice("sync", ka, netip.MustParseAddr("10.125.0.2"), freeUDPPort(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	cfg := DesiredConfig{NetworkCIDR: "10.125.0.0/24", Peers: []DesiredPeer{
		{PublicKey: kb.PublicKey().String(), AllowedIPs: []string{"10.125.0.3/32"}, Endpoint: "127.0.0.1:40001", PersistentKeepalive: 25 * time.Second},
		{PublicKey: kc.PublicKey().String(), AllowedIPs: []string{"10.125.0.4/32"}},
	}}
	if changed, err := d.SyncPeers(cfg); err != nil || !changed {
		t.Fatalf("first sync: changed=%v err=%v", changed, err)
	}
	if changed, _ := d.SyncPeers(cfg); changed {
		t.Fatal("identical config must be a no-op")
	}
	cfg.Peers = cfg.Peers[:1] // peer C left the network
	if changed, _ := d.SyncPeers(cfg); !changed {
		t.Fatal("removal not applied")
	}
	st := d.Inspect(context.Background(), "")
	if len(st.Peers) != 1 || st.Peers[0].PublicKey != kb.PublicKey().String() || st.Peers[0].Endpoint != "127.0.0.1:40001" {
		t.Fatalf("unexpected peers %+v", st.Peers)
	}
}
