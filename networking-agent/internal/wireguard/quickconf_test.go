package wireguard

import (
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func TestRenderQuickConfig(t *testing.T) {
	pk, _ := wgtypes.GeneratePrivateKey()
	cfg := DesiredConfig{
		Version:     4,
		NetworkCIDR: "10.100.0.0/24",
		Peers: []DesiredPeer{
			{PublicKey: keyA, AllowedIPs: []string{"10.100.0.3/32"}, Endpoint: "192.168.1.20:51820", PersistentKeepalive: 25 * time.Second},
			{PublicKey: keyB, AllowedIPs: []string{"10.100.0.4/32"}},
		},
	}
	out, err := RenderQuickConfig(pk, 51820, "10.100.0.2/24", cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"PrivateKey = " + pk.String(),
		"ListenPort = 51820",
		"Address = 10.100.0.2/24",
		"PublicKey = " + keyA,
		"AllowedIPs = 10.100.0.3/32",
		"Endpoint = 192.168.1.20:51820",
		"PersistentKeepalive = 25",
		"# No endpoint known yet",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "DNS") || strings.Contains(out, "0.0.0.0/0") {
		t.Fatal("config must not set DNS or a default route")
	}
}

func TestRenderQuickConfigRejectsUnsafeInput(t *testing.T) {
	pk, _ := wgtypes.GeneratePrivateKey()
	ok := DesiredConfig{NetworkCIDR: "10.100.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"10.100.0.3/32"}}}}
	if _, err := RenderQuickConfig(pk, 51820, "10.200.0.2/24", ok); err == nil {
		t.Error("address outside the network accepted")
	}
	if _, err := RenderQuickConfig(pk, 51820, "10.100.0.2", ok); err == nil {
		t.Error("address without prefix accepted")
	}
	bad := DesiredConfig{NetworkCIDR: "10.100.0.0/24", Peers: []DesiredPeer{{PublicKey: keyA, AllowedIPs: []string{"0.0.0.0/0"}}}}
	if _, err := RenderQuickConfig(pk, 51820, "10.100.0.2/24", bad); err == nil {
		t.Error("default-route AllowedIPs accepted")
	}
}
