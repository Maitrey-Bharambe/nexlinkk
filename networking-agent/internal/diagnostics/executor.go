// Package diagnostics executes approved, allowlisted commands from the
// control plane. Every command passes policy.Check first; there is no
// generic "run" or shell path.
package diagnostics

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/policy"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/transfer"
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
		Services                   []telemetry.Service `json:"services"`
	} `json:"peers"`
}

type EndpointCandidate struct {
	Endpoint string `json:"endpoint"`
	Kind     string `json:"kind"` // host_reported | reflexive_guess | relay
}

// RelayCandidate returns the peer's "relay:<id>" candidate, or "".
func RelayCandidate(cands []EndpointCandidate) string {
	for _, c := range cands {
		if c.Kind == "relay" && wireguard.IsRelayEndpoint(c.Endpoint) {
			return c.Endpoint
		}
	}
	return ""
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
	// Log receives progress lines (shown in the device's agent console).
	Log *slog.Logger
	// FlushEvents uploads buffered log lines immediately (optional).
	FlushEvents func(ctx context.Context)
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
		// The dial hook reaches peers inside a userspace tunnel (lab mode); the
		// control plane is always reached over the host network.
		dial := e.Dial
		if p.Target == "control_plane" {
			dial = nil
		}
		r := connectivity.TCPProbeWith(ctx, dial, addr, p.Count, 2*time.Second, 250*time.Millisecond)
		res.Measurements = r.Measurements(p.Target, ref)
		res.Output["target"] = addr
		res.Output["attempts"] = r.Attempts
		res.Output["successes"] = r.Successes
	case "transfer_test":
		p := params.(policy.TransferParams)
		if err := e.transferTest(ctx, p, &res); err != nil {
			return fail(err)
		}
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

// transferTest sends p.Megabytes of random data to the peer's transfer sink,
// through the tunnel, and records throughput plus the peer-confirmed checksum.
func (e *Executor) transferTest(ctx context.Context, p policy.TransferParams, res *Result) error {
	if e.Dial == nil {
		return errors.New("transfer tests need the userspace tunnel (run --userspace)")
	}
	addr, ref, err := e.resolveTarget(ctx, policy.ConnectivityParams{Target: "peer", PeerDeviceID: p.PeerDeviceID, Count: 1})
	if err != nil {
		return err
	}
	host, _, _ := net.SplitHostPort(addr)
	addr = net.JoinHostPort(host, strconv.Itoa(transfer.PortFor(e.ProbePort)))
	n := int64(p.Megabytes) << 20
	logf := func(msg string, args ...any) {
		if e.Log != nil {
			e.Log.Info(msg, args...)
		}
	}
	flush := func() {
		if e.FlushEvents != nil {
			e.FlushEvents(ctx)
		}
	}

	logf("transfer test starting", "peer", host, "bytes", n, "path", "wireguard tunnel")
	flush()
	conn, err := e.Dial(ctx, addr)
	if err != nil {
		return fmt.Errorf("peer transfer sink not reachable through the tunnel (peer agent too old or offline?): %w", err)
	}
	defer conn.Close()
	next := n / 4
	r, err := transfer.Send(ctx, conn, n, func(sent int64) {
		if sent >= next && sent < n {
			logf("transfer progress", "sent_mb", float64(sent)/(1<<20), "percent", sent*100/n)
			next += n / 4
		}
	})
	if err != nil {
		logf("transfer test failed", "error", err.Error())
		flush()
		return err
	}
	mbps := r.BitsPerSecond() / 1e6
	logf("transfer test finished", "mb", float64(r.Bytes)/(1<<20), "seconds", r.Duration.Seconds(), "mbit_s", mbps, "integrity", r.IntegrityMatch)
	flush()

	at := time.Now()
	target := telemetry.Target{Kind: "peer", Ref: ref}
	res.Measurements = append(res.Measurements, telemetry.Valid("throughput", "bps", "agent", target, r.BitsPerSecond(), 1, at))
	res.Output["target"] = addr
	res.Output["bytesSent"] = r.Bytes
	res.Output["bytesConfirmed"] = r.PeerBytes
	res.Output["durationMs"] = r.Duration.Milliseconds()
	res.Output["mbitPerSecond"] = mbps
	res.Output["sha256"] = hex.EncodeToString(r.SentSHA256[:])
	res.Output["peerSha256"] = hex.EncodeToString(r.PeerSHA256[:])
	res.Output["integrityMatch"] = r.IntegrityMatch
	return nil
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
// first host-reported one. Returns "" when nothing usable exists. Relay
// candidates are never picked here: userspace mode falls back to them when
// the direct path does not produce a handshake (see RelayCandidate).
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
