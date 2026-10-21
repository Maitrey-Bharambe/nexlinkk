package session

import (
	"context"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/nexlink/networking-agent/internal/telemetry"
)

func TestParseShare(t *testing.T) {
	got, err := ParseShare("rdp, SSH,http:3000,8080,rdp")
	if err != nil {
		t.Fatal(err)
	}
	want := []telemetry.Service{{Name: "rdp", Port: 3389}, {Name: "ssh", Port: 22}, {Name: "http", Port: 3000}, {Name: "tcp", Port: 8080}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %+v want %+v", got, want)
		}
	}
	for _, bad := range []string{"telnet", "tcp", "rdp:0", "http:99999"} {
		if _, err := ParseShare(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if s, _ := ParseShare(""); len(s) != 0 {
		t.Fatal("empty share should share nothing")
	}
}

func TestResolve(t *testing.T) {
	peers := []Peer{
		{DeviceID: "a1", Name: "Office-PC", IP: "10.0.0.2", Services: []telemetry.Service{{Name: "rdp", Port: 3389}}},
		{DeviceID: "b2", Name: "nas", IP: "10.0.0.3"},
	}
	if p, s, err := Resolve(peers, "office-pc", "rdp"); err != nil || p.IP != "10.0.0.2" || s.Port != 3389 {
		t.Fatalf("by name: %v %v %v", p, s, err)
	}
	if _, s, err := Resolve(peers, "10.0.0.2", ""); err != nil || s.Name != "rdp" {
		t.Fatalf("by ip, default service: %v %v", s, err)
	}
	if _, _, err := Resolve(peers, "office-pc", "ssh"); err == nil {
		t.Fatal("unshared service must be refused")
	}
	if _, _, err := Resolve(peers, "nas", "ssh"); err == nil {
		t.Fatal("device that shares nothing must be refused")
	}
	if _, _, err := Resolve(peers, "ghost", "rdp"); err == nil {
		t.Fatal("unknown device must be refused")
	}
}

// Category: end-to-end over loopback TCP. Tunnel listen/dial are replaced by
// plain sockets; everything else (gateway API + token, forward, share, local
// service) is the real code path.
func TestGatewayToSharedService(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// The "remote desktop" on the target host.
	svc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	go func() {
		for {
			c, err := svc.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()
	port := svc.Addr().(*net.TCPAddr).Port

	// Target side: share it on the "tunnel" (here another loopback port).
	var tunnelAddr string
	err = Share(ctx, func(int) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			tunnelAddr = ln.Addr().String()
		}
		return ln, err
	}, []telemetry.Service{{Name: "rdp", Port: port}}, log)
	if err != nil {
		t.Fatal(err)
	}

	// Operator side: gateway whose tunnel dial lands on the shared listener.
	gw := &Gateway{
		Dial: func(ctx context.Context, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", tunnelAddr)
		},
		Peers: func() []Peer {
			return []Peer{{DeviceID: "x", Name: "pc-2", IP: "10.9.0.3", Online: true, Path: "relay", Services: []telemetry.Service{{Name: "rdp", Port: port}}}}
		},
		Log: log,
	}
	infoPath := filepath.Join(t.TempDir(), "gw.json")
	if err := gw.Start(ctx, "self", infoPath); err != nil {
		t.Fatal(err)
	}
	info, err := LoadInfo(infoPath)
	if err != nil {
		t.Fatal(err)
	}

	bad := info
	bad.Token = "nope"
	var out ForwardResponse
	if err := Call(bad, "POST", "/v1/forward", ForwardRequest{Peer: "pc-2", Service: "rdp"}, &out); err == nil {
		t.Fatal("gateway accepted a wrong token")
	}
	if err := Call(info, "POST", "/v1/forward", ForwardRequest{Peer: "pc-2", Service: "rdp"}, &out); err != nil {
		t.Fatal(err)
	}

	c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(out.LocalPort))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	msg := []byte("mstsc says hi")
	_, _ = c.Write(msg)
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(c, got); err != nil || string(got) != string(msg) {
		t.Fatalf("session echo failed: %q %v", got, err)
	}
}
