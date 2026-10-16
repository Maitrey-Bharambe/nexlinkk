package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/diagnostics"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

// cmdExportConfig writes a WireGuard tunnel file for the desired peer set.
// This is the operator-driven way to bring a tunnel up with the official
// WireGuard app (Windows/macOS) or wg-quick (Linux): nothing on the host is
// changed by the agent itself.
func cmdExportConfig(ctx context.Context, args []string) error {
	cfg, fs := commonFlags("export-config", args)
	out := fs.String("out", "", "output file (default <interface>.conf; the file name becomes the tunnel name)")
	force := fs.Bool("force", false, "overwrite an existing file")
	fs.IntVar(&cfg.ListenPort, "listen-port", cfg.ListenPort, "WireGuard UDP listen port")
	_ = fs.Parse(args)
	id, err := loadEnrolled(cfg)
	if err != nil {
		return err
	}
	c := transport.New(cfg.ServerURL, id, id.State.DeviceID)
	ex := &diagnostics.Executor{Client: c}
	desired, err := ex.FetchDesired(ctx)
	if err != nil {
		return err
	}
	wg, err := desired.ToWireGuard(platform.LocalSubnets(cfg.Interface))
	if err != nil {
		return err
	}
	text, err := wireguard.RenderQuickConfig(id.WireGuardPrivateKey(), cfg.ListenPort, desired.Address, wg)
	if err != nil {
		return err
	}
	path := *out
	if path == "" {
		path = cfg.Interface + ".conf"
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if *force {
		flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s exists; pass --force to overwrite", path)
		}
		return err
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	fmt.Printf("wrote %s — config v%d, address %s, %d peer(s), listen udp/%d\n", path, wg.Version, desired.Address, len(wg.Peers), cfg.ListenPort)
	missing := 0
	for i, p := range wg.Peers {
		name := desired.Peers[i].Name
		if p.Endpoint == "" {
			missing++
			fmt.Printf("  peer %-20s no endpoint yet (run the agent on that PC, then re-export with --force)\n", name)
		} else {
			fmt.Printf("  peer %-20s endpoint %s\n", name, p.Endpoint)
		}
	}
	if len(wg.Peers) > 0 && missing == len(wg.Peers) {
		fmt.Println("note: WireGuard connects as long as at least ONE side knows the other's endpoint.")
	}
	fmt.Println("!! this file contains your private key: import it into WireGuard, activate, then delete the file.")
	return nil
}

func line(status, msg string) { fmt.Printf("  %-4s %s\n", status, msg) }

// cmdDoctor runs a read-only preflight for a real tunnel test and explains
// what to fix. It changes nothing on the host.
func cmdDoctor(ctx context.Context, args []string) error {
	cfg, fs := commonFlags("doctor", args)
	_ = fs.Parse(args)
	fmt.Println("nexlink doctor (read-only)")
	failures := 0
	fail := func(msg string) { failures++; line("FAIL", msg) }

	id, err := loadEnrolled(cfg)
	if err != nil {
		fail(err.Error())
		return errors.New("fix the above first")
	}
	line("ok", fmt.Sprintf("enrolled as %s (%s), tunnel address %s", id.State.DeviceName, id.State.DeviceID, id.State.Address))

	hc := &http.Client{Timeout: 5 * time.Second}
	if res, err := hc.Get(strings.TrimRight(cfg.ServerURL, "/") + "/healthz"); err != nil {
		fail(fmt.Sprintf("control plane %s unreachable: %v (firewall on the server PC must allow TCP 4000)", cfg.ServerURL, err))
	} else {
		res.Body.Close()
		line("ok", "control plane reachable at "+cfg.ServerURL)
	}

	c := transport.New(cfg.ServerURL, id, id.State.DeviceID)
	desired, err := (&diagnostics.Executor{Client: c}).FetchDesired(ctx)
	var wantPeers []wireguard.DesiredPeer
	if err != nil {
		fail("signed request rejected: " + err.Error())
	} else if desired.ConfigVersion == nil {
		fail("device has no active network membership")
	} else {
		wg, _ := desired.ToWireGuard(platform.LocalSubnets(cfg.Interface))
		wantPeers = wg.Peers
		line("ok", fmt.Sprintf("desired config v%d: %d peer(s)", *desired.ConfigVersion, len(wg.Peers)))
		if len(wg.Peers) == 0 {
			line("warn", "no peers yet — enroll the second PC into the same network")
		}
		for i, p := range wg.Peers {
			ep := p.Endpoint
			if ep == "" {
				ep = "unknown (that PC must run the agent first)"
			}
			line("", fmt.Sprintf("peer %s → %s, endpoint %s", desired.Peers[i].Name, strings.Join(p.AllowedIPs, ","), ep))
		}
	}

	st := wireguard.NewInspector().Inspect(ctx, cfg.Interface)
	switch {
	case st.Source == wireguard.SourceUnavailable:
		fail("cannot read WireGuard state: " + st.Error + " — run this terminal as Administrator and install WireGuard for Windows")
	case st.State == wireguard.StateAbsent:
		fail(fmt.Sprintf("interface %s not found — run `nexlink-agent export-config`, import %s.conf in the WireGuard app, Activate", cfg.Interface, cfg.Interface))
	case st.State != wireguard.StateUp:
		fail(fmt.Sprintf("interface %s is %s — Activate the tunnel in the WireGuard app", cfg.Interface, st.State))
	default:
		line("ok", fmt.Sprintf("interface %s up, listening udp/%d", cfg.Interface, st.ListenPort))
		if st.PublicKey != id.WireGuardPublicKey() {
			fail("tunnel uses a different key than the enrolled one — re-export and re-import the config")
		}
		have := map[string]wireguard.PeerStatus{}
		for _, p := range st.Peers {
			have[p.PublicKey] = p
		}
		for i, want := range wantPeers {
			name := desired.Peers[i].Name
			p, ok := have[want.PublicKey]
			switch {
			case !ok:
				fail("peer " + name + " missing from the tunnel — re-export (--force) and re-import")
			case p.LastHandshake.IsZero():
				fail(fmt.Sprintf("peer %s: no handshake yet — check both PCs' firewalls allow UDP %d inbound and at least one side has an endpoint", name, cfg.ListenPort))
			case time.Since(p.LastHandshake) > 180*time.Second:
				fail(fmt.Sprintf("peer %s: last handshake %s ago (stale)", name, time.Since(p.LastHandshake).Round(time.Second)))
			default:
				line("ok", fmt.Sprintf("peer %s: handshake %s ago — tunnel established", name, time.Since(p.LastHandshake).Round(time.Second)))
				ip := strings.SplitN(want.AllowedIPs[0], "/", 2)[0]
				r := connectivity.TCPProbe(ctx, net.JoinHostPort(ip, strconv.Itoa(cfg.ProbePort)), 3, 2*time.Second, 200*time.Millisecond)
				if r.Successes > 0 {
					line("ok", fmt.Sprintf("peer %s answers on tunnel %s:%d (%d/%d probes)", name, ip, cfg.ProbePort, r.Successes, r.Attempts))
				} else {
					line("warn", fmt.Sprintf("peer %s: no answer on %s:%d — is its agent running and TCP %d allowed on its firewall? (handshake already proves the tunnel)", name, ip, cfg.ProbePort, cfg.ProbePort))
				}
			}
		}
	}

	if failures > 0 {
		return fmt.Errorf("%d check(s) failed", failures)
	}
	fmt.Println("all checks passed")
	return nil
}
