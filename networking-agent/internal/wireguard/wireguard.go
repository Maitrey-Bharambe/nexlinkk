// Package wireguard is the agent's narrow interface to the WireGuard
// implementation (kernel module, wireguard-go, or WireGuardNT on Windows).
//
// Reading state (Inspector) and changing state (Applier) are separate types.
// The Applier is disabled unless privileged mode was explicitly enabled.
// No cryptography is implemented here; WireGuard does all of it.
package wireguard

import (
	"context"
	"errors"
	"net"
	"time"
)

// States reported for an interface.
const (
	StateUp      = "up"
	StateDown    = "down"
	StateAbsent  = "absent"
	StateUnknown = "unknown"
)

// Sources describe how a status was obtained.
const (
	SourceWgctrl      = "wgctrl"
	SourceUnavailable = "unavailable"
	SourceSimulated   = "simulated" // test fixtures only; never treated as real by the control plane
)

type PeerStatus struct {
	PublicKey     string
	Endpoint      string    // "" if none known
	LastHandshake time.Time // zero = never
	RxBytes       int64
	TxBytes       int64
	AllowedIPs    []string
}

type InterfaceStatus struct {
	Name       string
	State      string
	ListenPort int
	PublicKey  string
	Peers      []PeerStatus
	Source     string
	Error      string // why the state is unknown, if it is
}

// Inspector reads interface state. It never mutates anything.
type Inspector interface {
	Inspect(ctx context.Context, name string) InterfaceStatus
}

// DesiredPeer is one peer from the control plane's desired configuration.
type DesiredPeer struct {
	PublicKey           string
	AllowedIPs          []string
	Endpoint            string // ip:port literal or ""
	PersistentKeepalive time.Duration
}

// DesiredConfig is the full peer set the control plane wants on the interface.
type DesiredConfig struct {
	Version     int
	NetworkCIDR string
	Peers       []DesiredPeer
}

// Applier changes interface configuration. Only obtainable in privileged mode.
type Applier interface {
	Enabled() bool
	Apply(ctx context.Context, iface string, cfg DesiredConfig) error
}

// ErrPrivilegedDisabled is returned by the disabled applier.
var ErrPrivilegedDisabled = errors.New("privileged operations are disabled (set NEXLINK_ENABLE_PRIVILEGED=true to allow)")

type disabledApplier struct{}

func (disabledApplier) Enabled() bool { return false }
func (disabledApplier) Apply(context.Context, string, DesiredConfig) error {
	return ErrPrivilegedDisabled
}

// ValidateDesired enforces the safety envelope on a desired configuration
// before anything is applied: every AllowedIP must be a single host (/32)
// inside the network CIDR, so a bad or malicious config can never redirect
// default routes or unrelated subnets into the tunnel.
func ValidateDesired(cfg DesiredConfig) error {
	_, network, err := net.ParseCIDR(cfg.NetworkCIDR)
	if err != nil {
		return errors.New("desired config: invalid network CIDR")
	}
	seen := map[string]bool{}
	for _, p := range cfg.Peers {
		if p.PublicKey == "" || seen[p.PublicKey] {
			return errors.New("desired config: missing or duplicate peer key")
		}
		seen[p.PublicKey] = true
		for _, a := range p.AllowedIPs {
			ip, n, err := net.ParseCIDR(a)
			if err != nil {
				return errors.New("desired config: bad allowed IP " + a)
			}
			if ones, bits := n.Mask.Size(); ones != 32 || bits != 32 || !network.Contains(ip) {
				return errors.New("desired config: allowed IP " + a + " is not a /32 inside " + cfg.NetworkCIDR)
			}
		}
		if p.Endpoint != "" {
			host, _, err := net.SplitHostPort(p.Endpoint)
			if err != nil || net.ParseIP(host) == nil {
				return errors.New("desired config: endpoint must be an ip:port literal")
			}
		}
	}
	return nil
}
