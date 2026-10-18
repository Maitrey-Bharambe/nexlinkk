// Package diagnostics executes approved, allowlisted commands from the
// control plane. Every command passes policy.Check first; there is no
// generic "run" or shell path.
package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/policy"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

type Command struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Params     json.RawMessage `json:"params"`
	DeadlineAt time.Time       `json:"deadlineAt"`
}

type Result struct {
	Status       string                  `json:"status"` // succeeded | failed
	StartedAt    string                  `json:"startedAt"`
	FinishedAt   string                  `json:"finishedAt"`
	Output       map[string]any          `json:"output"`
	Error        *string                 `json:"error,omitempty"`
	Measurements []telemetry.Measurement `json:"measurements"`
}

// DesiredConfigResponse mirrors GET /api/v1/agent/config.
type DesiredConfigResponse struct {
	ConfigVersion *int `json:"configVersion"`
	Network       *struct {
		ID   string `json:"id"`
		CIDR string `json:"cidr"`
	} `json:"network"`
	Address string `json:"address"`
	Peers   []struct {
		DeviceID                   string              `json:"deviceId"`
		Name                       string              `json:"name"`
		PublicKey                  string              `json:"publicKey"`
		AllowedIPs                 []string            `json:"allowedIPs"`
		EndpointCandidates         []EndpointCandidate `json:"endpointCandidates"`
		PersistentKeepaliveSeconds int                 `json:"persistentKeepaliveSeconds"`
	} `json:"peers"`
}

type EndpointCandidate struct {
	Endpoint string `json:"endpoint"`
	Kind     string `json:"kind"` // host_reported | reflexive_guess
}

type Executor struct {
	Client     *transport.Client
	ServerURL  string
	Interface  string
	ProbePort  int
	Privileged bool
	Applier    wireguard.Applier
	// SendTelemetry pushes a fresh telemetry report (used by report/refresh).
	SendTelemetry func(ctx context.Context) error
	// OnApplied records the config version that was successfully applied.
	OnApplied func(version int)
	// Dial overrides the OS network for probes (lab mode: userspace tunnel).
	Dial connectivity.DialFunc
}

func (e *Executor) Execute(ctx context.Context, cmd Command) Result {
	start := time.Now()
	res := Result{Status: "failed", StartedAt: telemetry.Ts(start), Output: map[string]any{}, Measurements: []telemetry.Measurement{}}
	fail := func(err error) Result {
		msg := err.Error()
		if len(msg) > 480 {
			msg = msg[:480]
		}
		res.Error = &msg
		res.FinishedAt = telemetry.Ts(time.Now())
		return res
	}

	deadline := cmd.DeadlineAt
	if deadline.IsZero() || time.Until(deadline) > 2*time.Minute {
		deadline = time.Now().Add(2 * time.Minute)
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	params, err := policy.Check(cmd.Type, cmd.Params, e.Privileged)
	if err != nil {
		return fail(err)
	}

	switch cmd.Type {
	case "connectivity_test":
		p := params.(policy.ConnectivityParams)
		addr, ref, err := e.resolveTarget(ctx, p)
		if err != nil {
			return fail(err)
		}
		r := connectivity.TCPProbeWith(ctx, e.Dial, addr, p.Count, 2*time.Second, 250*time.Millisecond)
		res.Measurements = r.Measurements(p.Target, ref)
		res.Output["target"] = addr
		res.Output["attempts"] = r.Attempts
		res.Output["successes"] = r.Successes
	case "report_peer_status":
		if err := e.SendTelemetry(ctx); err != nil {
			return fail(fmt.Errorf("send telemetry: %w", err))
		}
		res.Output["reported"] = true
	case "refresh_vpn_config":
		v, err := e.applyDesired(ctx)
		if err != nil {
			return fail(err)
		}
		res.Output["appliedConfigVersion"] = v
		// Report post-change state *before* the result so verification has fresh evidence.
		if err := e.SendTelemetry(ctx); err != nil {
			return fail(fmt.Errorf("config applied but telemetry failed: %w", err))
		}
	default:
		return fail(policy.ErrUnknownCommand)
	}
	res.Status = "succeeded"
	res.FinishedAt = telemetry.Ts(time.Now())
	return res
}

// ResolveControlPlane returns host:port of the control plane for TCP probes.
func (e *Executor) ResolveControlPlane() (string, *string, error) {
	u, err := url.Parse(e.ServerURL)
	if err != nil {
		return "", nil, err
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[u.Scheme]
	}
	return net.JoinHostPort(u.Hostname(), port), nil, nil
}

func (e *Executor) resolveTarget(ctx context.Context, p policy.ConnectivityParams) (string, *string, error) {
	if p.Target == "control_plane" {
		return e.ResolveControlPlane()
	}
	cfg, err := e.FetchDesired(ctx)
	if err != nil {
		return "", nil, err
	}
	for _, peer := range cfg.Peers {
		if peer.DeviceID == p.PeerDeviceID && len(peer.AllowedIPs) > 0 {
			ip := strings.SplitN(peer.AllowedIPs[0], "/", 2)[0]
			ref := peer.PublicKey
			// Probe the peer's *tunnel* address, so success means traffic crossed the tunnel.
			return net.JoinHostPort(ip, strconv.Itoa(e.ProbePort)), &ref, nil
		}
	}
	return "", nil, errors.New("peer not present in desired configuration")
}

func (e *Executor) FetchDesired(ctx context.Context) (*DesiredConfigResponse, error) {
	var cfg DesiredConfigResponse
	if err := e.Client.Do(ctx, "GET", "/api/v1/agent/config", nil, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// PickEndpoint chooses one IP-literal candidate: first one on a subnet this
// host is directly attached to (same LAN), else a reflexive guess, else the
// first host-reported one. Returns "" when nothing usable exists. NAT
// traversal and relay selection are future work (docs/network-protocols.md).
func PickEndpoint(cands []EndpointCandidate, localNets []*net.IPNet) string {
	usable := make([]EndpointCandidate, 0, len(cands))
	for _, c := range cands {
		if host, _, err := net.SplitHostPort(c.Endpoint); err == nil && net.ParseIP(host) != nil {
			usable = append(usable, c)
		}
	}
	for _, c := range usable {
		host, _, _ := net.SplitHostPort(c.Endpoint)
		ip := net.ParseIP(host)
		for _, n := range localNets {
			if n.Contains(ip) {
				return c.Endpoint
			}
		}
	}
	for _, c := range usable {
		if c.Kind == "reflexive_guess" {
			return c.Endpoint
		}
	}
	if len(usable) > 0 {
		return usable[0].Endpoint
	}
	return ""
}

// ToWireGuard converts the control plane's desired config, picking one
// endpoint per peer relative to this host's own subnets.
func (c *DesiredConfigResponse) ToWireGuard(localNets []*net.IPNet) (wireguard.DesiredConfig, error) {
	if c.ConfigVersion == nil || c.Network == nil {
		return wireguard.DesiredConfig{}, errors.New("device has no active network membership")
	}
	out := wireguard.DesiredConfig{Version: *c.ConfigVersion, NetworkCIDR: c.Network.CIDR}
	for _, p := range c.Peers {
		out.Peers = append(out.Peers, wireguard.DesiredPeer{
			PublicKey:           p.PublicKey,
			AllowedIPs:          p.AllowedIPs,
			Endpoint:            PickEndpoint(p.EndpointCandidates, localNets),
			PersistentKeepalive: time.Duration(p.PersistentKeepaliveSeconds) * time.Second,
		})
	}
	return out, nil
}

func (e *Executor) applyDesired(ctx context.Context) (int, error) {
	if !e.Applier.Enabled() {
		return 0, wireguard.ErrPrivilegedDisabled
	}
	cfg, err := e.FetchDesired(ctx)
	if err != nil {
		return 0, err
	}
	desired, err := cfg.ToWireGuard(platform.LocalSubnets(e.Interface))
	if err != nil {
		return 0, err
	}
	if err := e.Applier.Apply(ctx, e.Interface, desired); err != nil {
		return 0, err
	}
	if e.OnApplied != nil {
		e.OnApplied(desired.Version)
	}
	return desired.Version, nil
}

// ApplyDesired is exposed for the explicit `nexlink-agent apply` CLI command.
func (e *Executor) ApplyDesired(ctx context.Context) (int, error) { return e.applyDesired(ctx) }
