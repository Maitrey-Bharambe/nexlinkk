package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/agent"
	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

// runUserspace runs the agent with its tunnel inside the process (wireguard-go
// with a private network stack). It needs no WireGuard app and no
// Administrator rights and changes no adapter, route or DNS setting — it only
// opens a UDP port. Peers come from the control plane and are kept in sync;
// probes and approved connectivity tests run through the tunnel.
func runUserspace(ctx context.Context, cfg *config.Config, id *identity.Identity, log *slog.Logger, events *agent.EventBuffer) error {
	ip, err := netip.ParseAddr(id.State.Address)
	if err != nil {
		return fmt.Errorf("enrollment has no tunnel address: %w", err)
	}
	cfg.Interface = "nexlink-userspace"
	dev, err := wireguard.NewUserspaceDevice(cfg.Interface, id.WireGuardPrivateKey(), ip, cfg.ListenPort)
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

	log.Info("userspace tunnel started", "tunnel_ip", ip.String(), "listen_udp", cfg.ListenPort, "note", "no WireGuard app or admin rights needed")

	a := agent.New(*cfg, id, dev, wireguard.NewApplier(false, id.WireGuardPrivateKey()), log)
	a.Events = events
	a.DisableResponder = true
	a.Executor().Dial = dial

	a.PeerSync = func(ctx context.Context) {
		desired, err := a.Executor().FetchDesired(ctx)
		if err != nil {
			log.Warn("could not fetch peers", "err", err)
			return
		}
		wg, err := desired.ToWireGuard(platform.LocalSubnets(""))
		if err != nil {
			log.Warn("no network membership; tunnel idle", "err", err)
			return
		}
		named := make([]string, 0, len(wg.Peers))
		for i := range wg.Peers {
			// Without a known endpoint we wait for the peer to reach us instead
			// of retrying handshakes into the void.
			if wg.Peers[i].Endpoint == "" {
				wg.Peers[i].PersistentKeepalive = 0
			}
			ep := wg.Peers[i].Endpoint
			if ep == "" {
				ep = "waiting"
			}
			named = append(named, desired.Peers[i].Name+"@"+ep)
		}
		changed, err := dev.SyncPeers(wg)
		if err != nil {
			log.Warn("peer sync failed", "err", err)
			return
		}
		if changed {
			log.Info("tunnel peers updated", "config_version", wg.Version, "peers", strings.Join(named, ", "))
		}
	}

	// Measure every peer with a fresh handshake through the tunnel.
	a.ExtraMeasurements = func(ctx context.Context) []telemetry.Measurement {
		var out []telemetry.Measurement
		n := 0
		for _, p := range dev.Inspect(ctx, "").Peers {
			if p.LastHandshake.IsZero() || time.Since(p.LastHandshake) > 3*time.Minute || len(p.AllowedIPs) == 0 || n >= 8 {
				continue
			}
			n++
			ip := strings.SplitN(p.AllowedIPs[0], "/", 2)[0]
			ref := p.PublicKey
			r := connectivity.TCPProbeWith(ctx, dial, net.JoinHostPort(ip, fmt.Sprint(cfg.ProbePort)), 3, 2*time.Second, 200*time.Millisecond)
			ms := r.Measurements("peer", &ref)
			out = append(out, ms...)
			if ms[0].Valid && ms[0].Value != nil {
				log.Info("tunnel probe", "peer_ip", ip, "rtt_ms", *ms[0].Value, "handshake", time.Since(p.LastHandshake).Round(time.Second).String()+" ago")
			}
		}
		return out
	}
	return a.Run(ctx)
}
