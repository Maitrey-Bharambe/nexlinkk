package wireguard

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// SourceUserspace marks state read from a wireguard-go device. It is the
// real WireGuard protocol (Noise handshake, ChaCha20-Poly1305), just not a
// kernel/WireGuardNT interface.
const SourceUserspace = "wireguard-go"

// UserspaceDevice is a WireGuard device run by wireguard-go with a private
// gVisor network stack. It creates no OS network adapter, routes or DNS and
// needs no privileges; it only opens a UDP socket for the tunnel. Used by
// `nexlink-agent lab` to run a real tunnel between two agents on one host.
type UserspaceDevice struct {
	Name       string
	Net        *netstack.Net
	dev        *device.Device
	listenPort int
}

func hexKey(k wgtypes.Key) string { return hex.EncodeToString(k[:]) }

func hexToBase64(h string) string {
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != 32 {
		return ""
	}
	k, _ := wgtypes.NewKey(b)
	return k.String()
}

// NewUserspaceDevice starts a wireguard-go device whose tunnel address is tunnelIP.
func NewUserspaceDevice(name string, privateKey wgtypes.Key, tunnelIP netip.Addr, listenPort int) (*UserspaceDevice, error) {
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{tunnelIP}, nil, 1420)
	if err != nil {
		return nil, fmt.Errorf("netstack: %w", err)
	}
	dev := device.NewDevice(tunDev, conn.NewStdNetBind(), device.NewLogger(device.LogLevelError, "["+name+"] "))
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n", hexKey(privateKey), listenPort)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("configure %s: %w", name, err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &UserspaceDevice{Name: name, Net: tnet, dev: dev, listenPort: listenPort}, nil
}

// SetPeers replaces the peer set, after the same safety validation the
// kernel applier uses (/32 AllowedIPs inside the network, IP-literal endpoints).
func (u *UserspaceDevice) SetPeers(cfg DesiredConfig) error {
	if err := ValidateDesired(cfg); err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("replace_peers=true\n")
	for _, p := range cfg.Peers {
		k, err := wgtypes.ParseKey(p.PublicKey)
		if err != nil {
			return fmt.Errorf("peer key: %w", err)
		}
		fmt.Fprintf(&b, "public_key=%s\nreplace_allowed_ips=true\n", hexKey(k))
		if p.Endpoint != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
		}
		if p.PersistentKeepalive > 0 {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", int(p.PersistentKeepalive.Seconds()))
		}
		for _, a := range p.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", a)
		}
	}
	return u.dev.IpcSet(b.String())
}

// Inspect implements Inspector by parsing the device's UAPI state.
func (u *UserspaceDevice) Inspect(_ context.Context, _ string) InterfaceStatus {
	st := InterfaceStatus{Name: u.Name, State: StateUnknown, Source: SourceUserspace, Peers: []PeerStatus{}}
	raw, err := u.dev.IpcGet()
	if err != nil {
		st.Error = err.Error()
		return st
	}
	return parseUAPI(u.Name, raw)
}

func parseUAPI(name, raw string) InterfaceStatus {
	st := InterfaceStatus{Name: name, State: StateUp, Source: SourceUserspace, Peers: []PeerStatus{}}
	var cur *PeerStatus
	var hsSec, hsNsec int64
	flush := func() {
		if cur == nil {
			return
		}
		if hsSec > 0 {
			cur.LastHandshake = time.Unix(hsSec, hsNsec)
		}
		st.Peers = append(st.Peers, *cur)
		cur, hsSec, hsNsec = nil, 0, 0
	}
	sc := bufio.NewScanner(strings.NewReader(raw))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch k {
		case "private_key":
			if b, err := hex.DecodeString(v); err == nil && len(b) == 32 {
				pk, _ := wgtypes.NewKey(b)
				st.PublicKey = pk.PublicKey().String()
			}
		case "listen_port":
			if cur == nil {
				st.ListenPort, _ = strconv.Atoi(v)
			}
		case "public_key":
			flush()
			cur = &PeerStatus{PublicKey: hexToBase64(v), AllowedIPs: []string{}}
		case "endpoint":
			if cur != nil {
				cur.Endpoint = v
			}
		case "last_handshake_time_sec":
			hsSec, _ = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			hsNsec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			if cur != nil {
				cur.RxBytes, _ = strconv.ParseInt(v, 10, 64)
			}
		case "tx_bytes":
			if cur != nil {
				cur.TxBytes, _ = strconv.ParseInt(v, 10, 64)
			}
		case "allowed_ip":
			if cur != nil {
				cur.AllowedIPs = append(cur.AllowedIPs, v)
			}
		}
	}
	flush()
	return st
}

func (u *UserspaceDevice) Close() { u.dev.Close() }

// SyncPeers brings the device's peer set in line with the desired config
// without disturbing live sessions: only new or changed peers are written,
// removed peers are deleted, and an endpoint is only (re)set while the peer
// has no fresh handshake (WireGuard learns roaming endpoints by itself).
// Returns whether anything changed.
func (u *UserspaceDevice) SyncPeers(cfg DesiredConfig) (bool, error) {
	if err := ValidateDesired(cfg); err != nil {
		return false, err
	}
	cur := map[string]PeerStatus{}
	for _, p := range u.Inspect(context.Background(), "").Peers {
		cur[p.PublicKey] = p
	}
	want := map[string]bool{}
	var b strings.Builder
	for _, p := range cfg.Peers {
		want[p.PublicKey] = true
		k, err := wgtypes.ParseKey(p.PublicKey)
		if err != nil {
			return false, fmt.Errorf("peer key: %w", err)
		}
		c, exists := cur[p.PublicKey]
		fresh := exists && !c.LastHandshake.IsZero() && time.Since(c.LastHandshake) < 3*time.Minute
		setEndpoint := p.Endpoint != "" && !fresh && (!exists || c.Endpoint != p.Endpoint)
		ipsChanged := !exists || !sameStrings(c.AllowedIPs, p.AllowedIPs)
		if exists && !setEndpoint && !ipsChanged {
			continue
		}
		fmt.Fprintf(&b, "public_key=%s\n", hexKey(k))
		if setEndpoint {
			fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
		}
		if p.PersistentKeepalive > 0 {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", int(p.PersistentKeepalive.Seconds()))
		}
		if ipsChanged {
			b.WriteString("replace_allowed_ips=true\n")
			for _, a := range p.AllowedIPs {
				fmt.Fprintf(&b, "allowed_ip=%s\n", a)
			}
		}
	}
	for key := range cur {
		if want[key] {
			continue
		}
		k, err := wgtypes.ParseKey(key)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "public_key=%s\nremove=true\n", hexKey(k))
	}
	if b.Len() == 0 {
		return false, nil
	}
	return true, u.dev.IpcSet(b.String())
}

// ListenPort returns the UDP port the device listens on.
func (u *UserspaceDevice) ListenPort() int { return u.listenPort }

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		if seen[x] == 0 {
			return false
		}
		seen[x]--
	}
	return true
}
