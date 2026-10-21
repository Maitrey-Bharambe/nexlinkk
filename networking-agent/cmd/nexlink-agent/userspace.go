package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/nexlink/networking-agent/internal/agent"
	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/diagnostics"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/relay"
	"github.com/nexlink/networking-agent/internal/session"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

// How long a path may go without a handshake before the agent tries the
// other one. Direct first (lowest latency), relay when direct stays silent,
// and an occasional retry of direct while on the relay.
const (
	directGrace   = 20 * time.Second
	relayRetry    = 3 * time.Minute
	pathTick      = 5 * time.Second
	configRefresh = 30 * time.Second
	fresh         = 3 * time.Minute
)

// runUserspace runs the agent with its tunnel inside the process (wireguard-go
// with a private network stack). It needs no WireGuard app and no
// Administrator rights and changes no adapter, route or DNS setting — it only
// opens a UDP port. Peers come from the control plane and are kept in sync;
// a peer that cannot be reached directly is reached through the relay.
// Probes, approved tests and remote sessions run through the tunnel.
func runUserspace(ctx context.Context, cfg *config.Config, id *identity.Identity, log *slog.Logger, events *agent.EventBuffer) error {
	ip, err := netip.ParseAddr(id.State.Address)
	if err != nil {
		return fmt.Errorf("enrollment has no tunnel address: %w", err)
	}
	shared, err := session.ParseShare(cfg.Share)
	if err != nil {
		return err
	}
	cfg.Interface = "nexlink-userspace"

	var rc *relay.Client
	var rt wireguard.RelayTransport // stays a nil interface when the relay is off
	if cfg.Relay {
		rc = relay.New(cfg.ServerURL, id.State.DeviceID, id, log)
		rt = rc
		go rc.Run(ctx)
	}
	dev, err := wireguard.NewUserspaceDeviceWithBind(cfg.Interface, id.WireGuardPrivateKey(), ip, cfg.ListenPort, wireguard.NewMuxBind(rt))
	if err != nil {
		return fmt.Errorf("start tunnel on udp/%d (is another agent using it? set --listen-port): %w", cfg.ListenPort, err)
	}
	defer dev.Close()

	// Probe responder on the tunnel address, inside the tunnel's network stack.
	ln, err := dev.Net.ListenTCPAddrPort(netip.AddrPortFrom(ip, uint16(cfg.ProbePort)))
	if err != nil {
		return err
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	dial := func(ctx context.Context, addr string) (net.Conn, error) {
		ap, err := netip.ParseAddrPort(addr)
		if err != nil {
			return nil, err
		}
		return dev.Net.DialContextTCPAddrPort(ctx, ap)
	}

	// Services this PC's owner chose to share, reachable from tunnel peers only.
	if err := session.Share(ctx, func(port int) (net.Listener, error) {
		return dev.Net.ListenTCPAddrPort(netip.AddrPortFrom(ip, uint16(port)))
	}, shared, log); err != nil {
		return err
	}

	relayNote := "off"
	if rc != nil {
		relayNote = "on (fallback when peers are not directly reachable)"
	}
	log.Info("userspace tunnel started", "tunnel_ip", ip.String(), "listen_udp", cfg.ListenPort, "relay", relayNote, "note", "no WireGuard app or admin rights needed")

	a := agent.New(*cfg, id, dev, wireguard.NewApplier(false, id.WireGuardPrivateKey()), log)
	a.Events = events
	a.DisableResponder = true
	a.Executor().Dial = dial
	a.Services = shared
	a.ExtraCapabilities = func() []string {
		caps := []string{"remote_session"}
		if rc != nil && rc.Connected() {
			caps = append(caps, "relay")
		}
		return caps
	}

	ps := &pathSelector{dev: dev, exec: a.Executor(), log: log, dial: dial, probePort: cfg.ProbePort, relayOn: rc != nil, forceRelay: cfg.ForceRelay && rc != nil, paths: map[string]*pathState{}}
	a.PeerSync = func(ctx context.Context) { ps.sync(ctx, true) }
	go func() {
		t := time.NewTicker(pathTick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				ps.sync(ctx, false)
			}
		}
	}()

	// Remote sessions from this PC: `nexlink-agent session <peer> rdp`.
	gw := &session.Gateway{Dial: dial, Peers: ps.peers, Refresh: func() { ps.sync(ctx, true) }, Log: log}
	if err := gw.Start(ctx, id.State.DeviceID, session.InfoPathIn(cfg.StateDir), session.DefaultInfoPath()); err != nil {
		log.Warn("remote session gateway unavailable", "err", err)
	}

	// Measure every peer with a fresh handshake through the tunnel.
	a.ExtraMeasurements = func(ctx context.Context) []telemetry.Measurement {
		var out []telemetry.Measurement
		n := 0
		for _, p := range dev.Inspect(ctx, "").Peers {
			if p.LastHandshake.IsZero() || time.Since(p.LastHandshake) > fresh || len(p.AllowedIPs) == 0 || n >= 8 {
				continue
			}
			n++
			ip := strings.SplitN(p.AllowedIPs[0], "/", 2)[0]
			ref := p.PublicKey
			r := connectivity.TCPProbeWith(ctx, dial, net.JoinHostPort(ip, fmt.Sprint(cfg.ProbePort)), 3, 2*time.Second, 200*time.Millisecond)
			ms := r.Measurements("peer", &ref)
			out = append(out, ms...)
			if ms[0].Valid && ms[0].Value != nil {
				log.Info("tunnel probe", "peer_ip", ip, "path", pathOf(p.Endpoint), "rtt_ms", *ms[0].Value, "handshake", time.Since(p.LastHandshake).Round(time.Second).String()+" ago")
			}
		}
		return out
	}
	return a.Run(ctx)
}

func pathOf(endpoint string) string {
	switch {
	case endpoint == "":
		return "none"
	case wireguard.IsRelayEndpoint(endpoint):
		return "relay"
	default:
		return "direct"
	}
}

type pathState struct {
	mode  string // direct | relay
	since time.Time
}

// pathSelector keeps the device's peers in line with the control plane and
// picks, per peer, the direct endpoint or the relay.
type pathSelector struct {
	dev        *wireguard.UserspaceDevice
	exec       *diagnostics.Executor
	log        *slog.Logger
	dial       func(ctx context.Context, addr string) (net.Conn, error)
	probePort  int
	relayOn    bool
	forceRelay bool

	mu      sync.Mutex
	desired *diagnostics.DesiredConfigResponse
	fetched time.Time
	paths   map[string]*pathState
}

func (s *pathSelector) sync(ctx context.Context, force bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if force || s.desired == nil || time.Since(s.fetched) > configRefresh {
		d, err := s.exec.FetchDesired(ctx)
		if err != nil {
			s.log.Warn("could not fetch peers", "err", err)
			if s.desired == nil {
				return
			}
		} else {
			s.desired, s.fetched = d, time.Now()
		}
	}
	wg, err := s.desired.ToWireGuard(platform.LocalSubnets(""))
	if err != nil {
		s.log.Warn("no network membership; tunnel idle", "err", err)
		return
	}
	cur := map[string]wireguard.PeerStatus{}
	for _, p := range s.dev.Inspect(ctx, "").Peers {
		cur[p.PublicKey] = p
	}
	now := time.Now()
	var kick []string
	named := make([]string, 0, len(wg.Peers))
	for i := range wg.Peers {
		p := &wg.Peers[i]
		dp := s.desired.Peers[i]
		direct := p.Endpoint
		if s.forceRelay {
			direct = ""
		}
		relayEP := ""
		if s.relayOn {
			relayEP = diagnostics.RelayCandidate(dp.EndpointCandidates)
		}
		st := s.paths[p.PublicKey]
		if st == nil {
			st = &pathState{mode: "direct", since: now}
			if direct == "" && relayEP != "" {
				st.mode = "relay"
			}
			s.paths[p.PublicKey] = st
		}
		c, exists := cur[p.PublicKey]
		isFresh := exists && !c.LastHandshake.IsZero() && now.Sub(c.LastHandshake) < fresh
		if !isFresh {
			switch {
			case st.mode == "direct" && relayEP != "" && (direct == "" || now.Sub(st.since) > directGrace):
				st.mode, st.since = "relay", now
				s.log.Info("no direct path to peer; using the encrypted relay", "peer", dp.Name)
				kick = append(kick, p.AllowedIPs...)
			case st.mode == "relay" && direct != "" && now.Sub(st.since) > relayRetry:
				st.mode, st.since = "direct", now
				kick = append(kick, p.AllowedIPs...)
			}
		}
		if st.mode == "relay" && relayEP != "" {
			p.Endpoint = relayEP
		}
		if p.Endpoint == "" {
			// Without any path we wait for the peer to reach us.
			p.PersistentKeepalive = 0
		}
		label := pathOf(p.Endpoint)
		if isFresh {
			label = pathOf(c.Endpoint) + ", connected"
		}
		named = append(named, dp.Name+" ("+label+")")
	}
	changed, err := s.dev.SyncPeers(wg)
	if err != nil {
		s.log.Warn("peer sync failed", "err", err)
		return
	}
	if changed {
		s.log.Info("tunnel peers updated", "config_version", wg.Version, "peers", strings.Join(named, ", "))
	}
	// A packet for the peer starts the WireGuard handshake on the new path now
	// instead of at the next keepalive.
	for _, a := range kick {
		ip := strings.SplitN(a, "/", 2)[0]
		go func() {
			c, err := s.dial(context.Background(), net.JoinHostPort(ip, fmt.Sprint(s.probePort)))
			if err == nil {
				c.Close()
			}
		}()
	}
}

// peers lists the devices remote sessions can be opened to.
func (s *pathSelector) peers() []session.Peer {
	s.mu.Lock()
	d := s.desired
	s.mu.Unlock()
	if d == nil {
		return nil
	}
	cur := map[string]wireguard.PeerStatus{}
	for _, p := range s.dev.Inspect(context.Background(), "").Peers {
		cur[p.PublicKey] = p
	}
	out := make([]session.Peer, 0, len(d.Peers))
	for _, p := range d.Peers {
		if len(p.AllowedIPs) == 0 {
			continue
		}
		c, ok := cur[p.PublicKey]
		online := ok && !c.LastHandshake.IsZero() && time.Since(c.LastHandshake) < fresh
		path := "none"
		if online {
			path = pathOf(c.Endpoint)
		}
		out = append(out, session.Peer{
			DeviceID: p.DeviceID,
			Name:     p.Name,
			IP:       strings.SplitN(p.AllowedIPs[0], "/", 2)[0],
			Online:   online,
			Path:     path,
			Services: p.Services,
		})
	}
	return out
}
