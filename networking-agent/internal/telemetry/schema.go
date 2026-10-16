// Package telemetry defines the versioned wire schema shared with the control
// plane (control-plane/src/modules/telemetry/telemetry.schema.js, version 1).
// Unavailable measurements are encoded as valid=false, value=null.
package telemetry

import (
	"time"

	"github.com/nexlink/networking-agent/internal/wireguard"
)

const SchemaVersion = 1

type Target struct {
	Kind string  `json:"kind"` // control_plane | peer | relay | interface
	Ref  *string `json:"ref"`
}

type Measurement struct {
	Type        string   `json:"type"` // rtt | jitter | packet_loss | throughput | handshake_age
	Target      Target   `json:"target"`
	Value       *float64 `json:"value"`
	Unit        string   `json:"unit"`
	Valid       bool     `json:"valid"`
	Source      string   `json:"source"`
	SampleCount *int     `json:"sampleCount,omitempty"`
	Error       *string  `json:"error,omitempty"`
	MeasuredAt  string   `json:"measuredAt"`
}

type Interface struct {
	Name                 *string `json:"name"`
	State                string  `json:"state"`
	ListenPort           *int    `json:"listenPort"`
	PublicKey            *string `json:"publicKey"`
	AppliedConfigVersion *int    `json:"appliedConfigVersion"`
	Source               string  `json:"source"`
}

type Peer struct {
	PublicKey       string   `json:"publicKey"`
	Endpoint        *string  `json:"endpoint"`
	LastHandshakeAt *string  `json:"lastHandshakeAt"`
	RxBytes         *int64   `json:"rxBytes"`
	TxBytes         *int64   `json:"txBytes"`
	AllowedIPs      []string `json:"allowedIPs"`
}

type Report struct {
	SchemaVersion      int           `json:"schemaVersion"`
	DeviceID           string        `json:"deviceId"`
	MeasuredAt         string        `json:"measuredAt"`
	Interface          Interface     `json:"interface"`
	Peers              []Peer        `json:"peers"`
	EndpointCandidates []string      `json:"endpointCandidates"`
	Measurements       []Measurement `json:"measurements"`
}

type Health struct {
	Status  string   `json:"status"` // ok | degraded | error
	Details []string `json:"details"`
}

type VPNInterface struct {
	Name  *string `json:"name"`
	State string  `json:"state"`
}

type Heartbeat struct {
	SchemaVersion int           `json:"schemaVersion"`
	DeviceID      string        `json:"deviceId"`
	BootID        string        `json:"bootId"`
	Sequence      int64         `json:"sequence"`
	AgentTime     string        `json:"agentTime"`
	AgentVersion  string        `json:"agentVersion"`
	Health        Health        `json:"health"`
	VPNInterface  *VPNInterface `json:"vpnInterface"`
	Capabilities  []string      `json:"capabilities"`
}

func Ts(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Valid builds a measured value.
func Valid(typ, unit, source string, target Target, value float64, samples int, at time.Time) Measurement {
	return Measurement{Type: typ, Target: target, Value: &value, Unit: unit, Valid: true, Source: source, SampleCount: &samples, MeasuredAt: Ts(at)}
}

// Unavailable builds an explicitly-missing value. It never carries a number.
func Unavailable(typ, unit, source string, target Target, reason string, samples int, at time.Time) Measurement {
	return Measurement{Type: typ, Target: target, Value: nil, Unit: unit, Valid: false, Source: source, SampleCount: &samples, Error: &reason, MeasuredAt: Ts(at)}
}

// FromInterface converts an inspected interface into wire form.
func FromInterface(st wireguard.InterfaceStatus, applied *int) (Interface, []Peer) {
	iface := Interface{Name: strp(st.Name), State: st.State, PublicKey: strp(st.PublicKey), AppliedConfigVersion: applied, Source: st.Source}
	if st.ListenPort > 0 {
		lp := st.ListenPort
		iface.ListenPort = &lp
	}
	peers := make([]Peer, 0, len(st.Peers))
	for _, p := range st.Peers {
		wp := Peer{PublicKey: p.PublicKey, Endpoint: strp(p.Endpoint), AllowedIPs: p.AllowedIPs}
		if wp.AllowedIPs == nil {
			wp.AllowedIPs = []string{}
		}
		if !p.LastHandshake.IsZero() {
			s := Ts(p.LastHandshake)
			wp.LastHandshakeAt = &s
		}
		rx, tx := p.RxBytes, p.TxBytes
		wp.RxBytes, wp.TxBytes = &rx, &tx
		peers = append(peers, wp)
	}
	return iface, peers
}
