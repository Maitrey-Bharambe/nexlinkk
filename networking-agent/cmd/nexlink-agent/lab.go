package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/nexlink/networking-agent/internal/agent"
	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/diagnostics"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/telemetry"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

type labSide struct {
	name string
	id   *identity.Identity
	port int
	dev  *wireguard.UserspaceDevice
	ip   netip.Addr
	ag   *agent.Agent
	log  *slog.Logger
	mu   sync.Mutex
	rtt  *float64
}

// cmdLab runs a REAL WireGuard tunnel between two enrolled agents on this
// machine using wireguard-go (userspace) devices with private network stacks.
// No OS adapter, route or DNS is created; only two loopback UDP sockets.
// Both agents report live telemetry, so the console shows the link exactly
// as it would for two PCs — but this is not a cross-machine / NAT test.
func cmdLab(ctx context.Context, args []string) error {
	cfg := config.FromEnv()
	fs := flag.NewFlagSet("lab", flag.ExitOnError)
	fs.StringVar(&cfg.ServerURL, "server", cfg.ServerURL, "control plane URL")
	dirA := fs.String("a", "", "state dir of the first enrolled agent")
	dirB := fs.String("b", "", "state dir of the second enrolled agent")
	portA := fs.Int("port-a", 51830, "UDP port for device A (loopback)")
	portB := fs.Int("port-b", 51831, "UDP port for device B (loopback)")
	dur := fs.Duration("duration", 90*time.Second, "how long to run (0 = until Ctrl+C)")
	_ = fs.Parse(args)
	if *dirA == "" || *dirB == "" {
		return errors.New("usage: nexlink-agent lab --server URL --a <stateDirA> --b <stateDirB>")
	}
	cfg.HeartbeatInterval, cfg.TelemetryInterval = 10*time.Second, 10*time.Second
	if err := cfg.Validate(); err != nil {
		return err
	}
	if *dur > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *dur)
		defer cancel()
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	sides := []*labSide{{name: "A", port: *portA}, {name: "B", port: *portB}}
	for i, dir := range []string{*dirA, *dirB} {
		id, err := identity.LoadOrCreate(dir)
		if err != nil {
			return err
		}
		if !id.Enrolled() {
			return fmt.Errorf("%s is not enrolled; run `nexlink-agent enroll --state-dir %s` first", dir, dir)
		}
		ip, err := netip.ParseAddr(id.State.Address)
		if err != nil {
			return fmt.Errorf("%s: bad tunnel address %q", dir, id.State.Address)
		}
		sides[i].id, sides[i].ip = id, ip
	}
	if sides[0].id.State.NetworkID != sides[1].id.State.NetworkID {
		return errors.New("both agents must be enrolled in the same network")
	}

	for i, s := range sides {
		other := sides[1-i]
		dev, err := wireguard.NewUserspaceDevice("nexlink-lab-"+s.name, s.id.WireGuardPrivateKey(), s.ip, s.port)
		if err != nil {
			return err
		}
		s.dev = dev
		defer dev.Close()

		// Desired peers come from the control plane, exactly as in production.
		c := transport.New(cfg.ServerURL, s.id, s.id.State.DeviceID)
		desired, err := (&diagnostics.Executor{Client: c}).FetchDesired(ctx)
		if err != nil {
			return fmt.Errorf("agent %s: %w", s.name, err)
		}
		wg, err := desired.ToWireGuard(nil)
		if err != nil {
			return err
		}
		// Keep only the lab partner: other peers are real hosts that are not
		// part of this run (their links simply stay "configured").
		var partner []wireguard.DesiredPeer
		for _, p := range wg.Peers {
			if p.PublicKey == other.id.WireGuardPublicKey() {
				p.Endpoint = "127.0.0.1:" + strconv.Itoa(other.port)
				partner = append(partner, p)
			}
		}
		if len(partner) == 0 {
			return fmt.Errorf("agent %s: control plane does not list agent %s as a peer (is it active in the network?)", s.name, other.name)
		}
		if skipped := len(wg.Peers) - len(partner); skipped > 0 && i == 0 {
			fmt.Printf("lab: %d other peer(s) in the network are not part of this run and stay \"configured\"\n", skipped)
		}
		wg.Peers = partner
		if err := dev.SetPeers(wg); err != nil {
			return err
		}

		// Probe responder on the tunnel address inside this device's network stack.
		ln, err := dev.Net.ListenTCPAddrPort(netip.AddrPortFrom(s.ip, uint16(cfg.ProbePort)))
		if err != nil {
			return err
		}
		defer ln.Close()
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				conn.Close()
			}
		}()
	}

	var wg sync.WaitGroup
	for i, s := range sides {
		s, other := s, sides[1-i]
		acfg := cfg
		acfg.Interface, acfg.ListenPort = s.dev.Name, s.port
		// Each side streams its own output to its device's console in the UI.
		events := agent.NewEventBuffer(500)
		s.log = agent.NewEventLogger(log.Handler().WithAttrs([]slog.Attr{slog.String("agent", s.name)}), events)
		s.log.Info("lab tunnel starting", "mode", "wireguard-go (userspace)", "tunnel_ip", s.ip.String(), "udp", "127.0.0.1:"+strconv.Itoa(s.port), "peer", other.id.State.DeviceName)
		s.ag = agent.New(acfg, s.id, s.dev, wireguard.NewApplier(false, s.id.WireGuardPrivateKey()), s.log)
		s.ag.Events = events
		s.ag.DisableResponder = true
		s.ag.Executor().Dial = func(ctx context.Context, addr string) (net.Conn, error) {
			ap, err := netip.ParseAddrPort(addr)
			if err != nil {
				return nil, err
			}
			return s.dev.Net.DialContextTCPAddrPort(ctx, ap)
		}
		s.ag.CandidatesOverride = func() []string { return []string{"127.0.0.1:" + strconv.Itoa(s.port)} }
		dial := func(ctx context.Context, addr string) (net.Conn, error) {
			ap, err := netip.ParseAddrPort(addr)
			if err != nil {
				return nil, err
			}
			return s.dev.Net.DialContextTCPAddrPort(ctx, ap)
		}
		target := netip.AddrPortFrom(other.ip, uint16(cfg.ProbePort)).String()
		ref := other.id.WireGuardPublicKey()
		s.ag.ExtraMeasurements = func(ctx context.Context) []telemetry.Measurement {
			r := connectivity.TCPProbeWith(ctx, dial, target, 3, 2*time.Second, 200*time.Millisecond)
			ms := r.Measurements("peer", &ref)
			s.mu.Lock()
			s.rtt = ms[0].Value
			s.mu.Unlock()
			return ms
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.ag.Run(ctx); err != nil {
				fmt.Fprintf(os.Stderr, "agent %s stopped: %v\n", s.name, err)
			}
		}()
	}

	fmt.Printf("lab: %s (%s) ⇄ %s (%s) over real WireGuard (wireguard-go), udp 127.0.0.1:%d ⇄ :%d\n",
		sides[0].id.State.DeviceName, sides[0].ip, sides[1].id.State.DeviceName, sides[1].ip, sides[0].port, sides[1].port)
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	report := func() bool {
		ok := true
		for _, s := range sides {
			st := s.dev.Inspect(ctx, "")
			hs := "never"
			fresh := false
			if len(st.Peers) > 0 {
				for _, p := range st.Peers {
					if p.LastHandshake.IsZero() {
						continue
					}
					age := time.Since(p.LastHandshake).Round(time.Second)
					hs, fresh = age.String()+" ago", age < 180*time.Second
				}
			}
			s.mu.Lock()
			rtt := "not measured"
			if s.rtt != nil {
				rtt = fmt.Sprintf("%.2f ms", *s.rtt)
			} else {
				ok = false
			}
			s.mu.Unlock()
			ok = ok && fresh
			fmt.Printf("  %s %-14s handshake %-8s  tunnel RTT %s\n", s.name, s.id.State.DeviceName, hs, rtt)
			s.log.Info("tunnel status", "handshake", hs, "tunnel_rtt", rtt)
		}
		return ok
	}
	last := false
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			if last {
				fmt.Println("result: tunnel established and verified by handshake + probes through the tunnel")
				return nil
			}
			return errors.New("result: tunnel NOT verified (no fresh handshake or probes failed)")
		case <-tick.C:
			last = report()
		}
	}
}
