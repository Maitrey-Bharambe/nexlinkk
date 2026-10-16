package wireguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"

	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

type wgctrlInspector struct{}

// NewInspector returns an Inspector backed by wgctrl. Reading WireGuard state
// usually needs root / Administrator; without it the result is "unknown"
// with source "unavailable" — never a guessed value.
func NewInspector() Inspector { return wgctrlInspector{} }

func (wgctrlInspector) Inspect(_ context.Context, name string) InterfaceStatus {
	st := InterfaceStatus{Name: name, State: StateUnknown, Source: SourceUnavailable, Peers: []PeerStatus{}}
	c, err := wgctrl.New()
	if err != nil {
		st.Error = fmt.Sprintf("wgctrl unavailable: %v", err)
		return st
	}
	defer c.Close()

	dev, err := c.Device(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			st.State, st.Source = StateAbsent, SourceWgctrl
			st.Error = "interface not found"
			return st
		}
		st.Error = fmt.Sprintf("read device: %v", err)
		return st
	}

	st.Source = SourceWgctrl
	st.ListenPort = dev.ListenPort
	st.PublicKey = dev.PublicKey.String()
	st.State = StateDown
	if ifc, err := net.InterfaceByName(name); err == nil && ifc.Flags&net.FlagUp != 0 {
		st.State = StateUp
	}
	for _, p := range dev.Peers {
		ps := PeerStatus{
			PublicKey:     p.PublicKey.String(),
			LastHandshake: p.LastHandshakeTime,
			RxBytes:       p.ReceiveBytes,
			TxBytes:       p.TransmitBytes,
		}
		if p.Endpoint != nil {
			ps.Endpoint = p.Endpoint.String()
		}
		for _, a := range p.AllowedIPs {
			ps.AllowedIPs = append(ps.AllowedIPs, a.String())
		}
		st.Peers = append(st.Peers, ps)
	}
	return st
}

type wgctrlApplier struct {
	privateKey wgtypes.Key
	inspector  Inspector
}

// NewApplier returns a real applier only when privileged is true; otherwise
// every Apply call fails with ErrPrivilegedDisabled.
//
// The applier sets the interface private key (the enrolled key) and replaces
// the peer set. It does NOT create interfaces, assign addresses, or touch the
// routing table — those are done once by the operator (see README).
func NewApplier(privileged bool, privateKey wgtypes.Key) Applier {
	if !privileged {
		return disabledApplier{}
	}
	return &wgctrlApplier{privateKey: privateKey, inspector: NewInspector()}
}

func (a *wgctrlApplier) Enabled() bool { return true }

func (a *wgctrlApplier) Apply(ctx context.Context, iface string, cfg DesiredConfig) error {
	if err := ValidateDesired(cfg); err != nil {
		return err
	}
	peers := make([]wgtypes.PeerConfig, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		key, err := wgtypes.ParseKey(p.PublicKey)
		if err != nil {
			return fmt.Errorf("peer key: %w", err)
		}
		pc := wgtypes.PeerConfig{PublicKey: key, ReplaceAllowedIPs: true}
		for _, s := range p.AllowedIPs {
			_, n, _ := net.ParseCIDR(s)
			pc.AllowedIPs = append(pc.AllowedIPs, *n)
		}
		if p.Endpoint != "" {
			if pc.Endpoint, err = net.ResolveUDPAddr("udp", p.Endpoint); err != nil {
				return fmt.Errorf("peer endpoint: %w", err)
			}
		}
		if p.PersistentKeepalive > 0 {
			ka := p.PersistentKeepalive
			pc.PersistentKeepaliveInterval = &ka
		}
		peers = append(peers, pc)
	}

	c, err := wgctrl.New()
	if err != nil {
		return fmt.Errorf("wgctrl: %w", err)
	}
	defer c.Close()
	pk := a.privateKey
	if err := c.ConfigureDevice(iface, wgtypes.Config{PrivateKey: &pk, ReplacePeers: true, Peers: peers}); err != nil {
		return fmt.Errorf("configure %s: %w", iface, err)
	}

	// Verify: read back and confirm the peer set matches what was requested.
	st := a.inspector.Inspect(ctx, iface)
	if st.Source != SourceWgctrl {
		return fmt.Errorf("verify: could not read back interface: %s", st.Error)
	}
	got := map[string]bool{}
	for _, p := range st.Peers {
		got[p.PublicKey] = true
	}
	for _, p := range cfg.Peers {
		if !got[p.PublicKey] {
			return fmt.Errorf("verify: peer %s missing after apply", p.PublicKey)
		}
	}
	if len(st.Peers) != len(cfg.Peers) {
		return fmt.Errorf("verify: expected %d peers, interface has %d", len(cfg.Peers), len(st.Peers))
	}
	return nil
}
