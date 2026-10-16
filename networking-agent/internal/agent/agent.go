// Package agent runs the heartbeat / telemetry / command loop.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/diagnostics"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

type Agent struct {
	cfg       config.Config
	id        *identity.Identity
	client    *transport.Client
	inspector wireguard.Inspector
	executor  *diagnostics.Executor
	log       *slog.Logger

	bootID string
	seq    int64

	mu         sync.Mutex
	lastIface  wireguard.InterfaceStatus
	appliedVer *int

	responder net.Listener
}

// ensureResponder starts the tunnel-address probe responder once the tunnel
// interface (and therefore its address) exists. Retried on every heartbeat.
func (a *Agent) ensureResponder() {
	if a.responder != nil || a.id.State.Address == "" {
		return
	}
	ln, err := connectivity.StartResponder(a.id.State.Address, a.cfg.ProbePort)
	if err != nil {
		return // tunnel not up yet
	}
	a.responder = ln
	a.log.Info("probe responder listening on tunnel address", "addr", ln.Addr().String())
}

func New(cfg config.Config, id *identity.Identity, inspector wireguard.Inspector, applier wireguard.Applier, log *slog.Logger) *Agent {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	a := &Agent{
		cfg:       cfg,
		id:        id,
		client:    transport.New(cfg.ServerURL, id, id.State.DeviceID),
		inspector: inspector,
		log:       log,
		bootID:    base64.RawURLEncoding.EncodeToString(b),
	}
	a.executor = &diagnostics.Executor{
		Client:        a.client,
		ServerURL:     cfg.ServerURL,
		Interface:     cfg.Interface,
		ProbePort:     cfg.ProbePort,
		Privileged:    cfg.Privileged,
		Applier:       applier,
		SendTelemetry: a.SendTelemetry,
		OnApplied: func(v int) {
			a.mu.Lock()
			a.appliedVer = &v
			a.mu.Unlock()
		},
	}
	return a
}

func (a *Agent) Executor() *diagnostics.Executor { return a.executor }

func (a *Agent) capabilities(src string) []string {
	caps := []string{"telemetry", "connectivity_probe"}
	if src == wireguard.SourceWgctrl {
		caps = append(caps, "wireguard_inspect")
	}
	if a.cfg.Privileged {
		caps = append(caps, "wireguard_apply")
	}
	return caps
}

func (a *Agent) inspect(ctx context.Context) wireguard.InterfaceStatus {
	st := a.inspector.Inspect(ctx, a.cfg.Interface)
	a.mu.Lock()
	a.lastIface = st
	a.mu.Unlock()
	return st
}

type heartbeatResp struct {
	PendingCommands int `json:"pendingCommands"`
}

func (a *Agent) heartbeat(ctx context.Context) (int, error) {
	a.mu.Lock()
	st := a.lastIface
	a.mu.Unlock()
	a.seq++
	health := telemetry.Health{Status: "ok", Details: []string{}}
	if st.Source == wireguard.SourceUnavailable {
		health = telemetry.Health{Status: "degraded", Details: []string{"cannot read WireGuard state: " + truncate(st.Error, 150)}}
	}
	name := a.cfg.Interface
	hb := telemetry.Heartbeat{
		SchemaVersion: telemetry.SchemaVersion,
		DeviceID:      a.id.State.DeviceID,
		BootID:        a.bootID,
		Sequence:      a.seq,
		AgentTime:     telemetry.Ts(time.Now()),
		AgentVersion:  config.Version,
		Health:        health,
		VPNInterface:  &telemetry.VPNInterface{Name: &name, State: orUnknown(st.State)},
		Capabilities:  a.capabilities(st.Source),
	}
	var out heartbeatResp
	err := a.client.Do(ctx, "POST", "/api/v1/agent/heartbeat", hb, &out)
	return out.PendingCommands, err
}

// SendTelemetry inspects the interface, probes the control plane and reports.
func (a *Agent) SendTelemetry(ctx context.Context) error {
	st := a.inspect(ctx)
	a.mu.Lock()
	applied := a.appliedVer
	a.mu.Unlock()
	iface, peers := telemetry.FromInterface(st, applied)

	// Control-plane reachability: 3 TCP connects. This measures the control
	// channel only; tunnel health comes from WireGuard handshakes above.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	addr, _, err := a.executor.ResolveControlPlane()
	measurements := []telemetry.Measurement{}
	if err == nil {
		measurements = connectivity.TCPProbe(probeCtx, addr, 3, 2*time.Second, 200*time.Millisecond).Measurements("control_plane", nil)
	}
	report := telemetry.Report{
		SchemaVersion:      telemetry.SchemaVersion,
		DeviceID:           a.id.State.DeviceID,
		MeasuredAt:         telemetry.Ts(time.Now()),
		Interface:          iface,
		Peers:              peers,
		EndpointCandidates: platform.EndpointCandidates(listenPortOr(st.ListenPort, a.cfg.ListenPort), a.cfg.Interface),
		Measurements:       measurements,
	}
	return a.client.Do(ctx, "POST", "/api/v1/agent/telemetry", report, nil)
}

func (a *Agent) pollCommands(ctx context.Context) {
	var cmds []diagnostics.Command
	if err := a.client.Do(ctx, "GET", "/api/v1/agent/commands", nil, &cmds); err != nil {
		a.log.Warn("poll commands failed", "err", err)
		return
	}
	for _, c := range cmds {
		a.log.Info("executing approved command", "id", c.ID, "type", c.Type)
		res := a.executor.Execute(ctx, c)
		var ack struct{}
		if err := a.client.Do(ctx, "POST", "/api/v1/agent/commands/"+c.ID+"/result", res, &ack); err != nil {
			a.log.Warn("report command result failed", "id", c.ID, "err", err)
		} else {
			a.log.Info("command finished", "id", c.ID, "status", res.Status)
		}
	}
}

// Run loops until ctx is cancelled or the device is revoked.
func (a *Agent) Run(ctx context.Context) error {
	a.log.Info("agent starting", "device", a.id.State.DeviceID, "interface", a.cfg.Interface, "privileged", a.cfg.Privileged)
	a.inspect(ctx)
	if err := a.SendTelemetry(ctx); err != nil {
		if fatal(err) {
			return err
		}
		a.log.Warn("initial telemetry failed", "err", err)
	}

	defer func() {
		if a.responder != nil {
			a.responder.Close()
		}
	}()
	a.ensureResponder()

	hb := time.NewTicker(a.cfg.HeartbeatInterval)
	tm := time.NewTicker(a.cfg.TelemetryInterval)
	defer hb.Stop()
	defer tm.Stop()

	tick := func() error {
		pending, err := a.heartbeat(ctx)
		if err != nil {
			if fatal(err) {
				return err
			}
			a.log.Warn("heartbeat failed", "err", err)
			return nil
		}
		if pending > 0 {
			a.pollCommands(ctx)
		}
		return nil
	}
	if err := tick(); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-hb.C:
			a.inspect(ctx)
			a.ensureResponder()
			if err := tick(); err != nil {
				return err
			}
		case <-tm.C:
			if err := a.SendTelemetry(ctx); err != nil {
				if fatal(err) {
					return err
				}
				a.log.Warn("telemetry failed", "err", err)
			}
		}
	}
}

// fatal errors stop the agent instead of retrying forever.
func fatal(err error) bool {
	var api *transport.APIError
	if errors.As(err, &api) {
		switch api.Code {
		case "DEVICE_REVOKED", "DEVICE_NOT_ENROLLED", "AGENT_UNKNOWN":
			return true
		}
	}
	return false
}

// listenPortOr prefers the port the live interface reports, falling back to
// the configured one so peers can learn our endpoint before the tunnel exists.
func listenPortOr(live, configured int) int {
	if live > 0 {
		return live
	}
	return configured
}

func orUnknown(s string) string {
	if s == "" {
		return wireguard.StateUnknown
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
