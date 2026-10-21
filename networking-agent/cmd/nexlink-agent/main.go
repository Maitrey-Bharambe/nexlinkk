// Command nexlink-agent is the NexLink endpoint networking agent.
//
//	nexlink-agent enroll --server https://cp.example   # token read from NEXLINK_ENROLLMENT_TOKEN or stdin
//	nexlink-agent run                                  # heartbeat / telemetry / approved commands
//	nexlink-agent run --userspace --share rdp          # tunnel in-process; relay fallback; share Remote Desktop
//	nexlink-agent session pc-2 rdp                     # remote session to another device, through the tunnel
//	nexlink-agent status                               # local, read-only inspection
//	nexlink-agent probe --target host:port             # one bounded TCP probe
//	nexlink-agent apply                                # explicit WireGuard apply (privileged mode only)
//	nexlink-agent export-config                        # write a tunnel file for the WireGuard app
//	nexlink-agent doctor                               # preflight checklist for a real tunnel test
//	nexlink-agent lab --a DIR --b DIR                  # real WireGuard tunnel between two agents on one host
//	nexlink-agent install / uninstall / service-status  # run as a background Windows service (Administrator)
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/nexlink/networking-agent/internal/agent"
	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/connectivity"
	"github.com/nexlink/networking-agent/internal/enrollment"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/platform"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

func main() {
	// Started by the Windows Service Control Manager: no console, no flags parsing here.
	if isWindowsService() {
		if err := runService(os.Args[2:]); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch os.Args[1] {
	case "enroll":
		err = cmdEnroll(ctx, os.Args[2:])
	case "run":
		err = cmdRun(ctx, os.Args[2:], log)
	case "session":
		err = cmdSession(os.Args[2:])
	case "status":
		err = cmdStatus(ctx, os.Args[2:])
	case "probe":
		err = cmdProbe(ctx, os.Args[2:])
	case "apply":
		err = cmdApply(ctx, os.Args[2:], log)
	case "export-config":
		err = cmdExportConfig(ctx, os.Args[2:])
	case "doctor":
		err = cmdDoctor(ctx, os.Args[2:])
	case "lab":
		err = cmdLab(ctx, os.Args[2:])
	case "install":
		err = cmdInstall(os.Args[2:])
	case "uninstall":
		err = cmdUninstall()
	case "service-status":
		err = cmdServiceStatus()
	case "service":
		err = runService(os.Args[2:]) // "--debug" runs the service handler in this console
	case "version":
		fmt.Println(config.Version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: nexlink-agent <enroll|run|session|status|doctor|export-config|lab|probe|apply|install|uninstall|service-status|version> [flags]")
}

// commonFlags returns a pointer: flags are parsed into this same struct later.
func commonFlags(name string, args []string) (*config.Config, *flag.FlagSet) {
	c := config.FromEnv()
	cfg := &c
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	fs.StringVar(&cfg.ServerURL, "server", cfg.ServerURL, "control plane URL")
	fs.StringVar(&cfg.StateDir, "state-dir", cfg.StateDir, "directory for keys and enrollment state")
	fs.StringVar(&cfg.Interface, "interface", cfg.Interface, "WireGuard interface name")
	fs.BoolVar(&cfg.AllowHTTP, "allow-http", cfg.AllowHTTP, "allow plain http to a non-loopback server (lab LAN only)")
	fs.BoolVar(&cfg.Privileged, "enable-privileged", cfg.Privileged, "allow approved commands to change the WireGuard interface")
	fs.BoolVar(&cfg.Userspace, "userspace", cfg.Userspace, "run the tunnel inside the agent (no WireGuard app or Administrator needed)")
	fs.IntVar(&cfg.ListenPort, "listen-port", cfg.ListenPort, "WireGuard UDP listen port")
	fs.BoolVar(&cfg.Relay, "relay", cfg.Relay, "userspace: fall back to the encrypted relay when peers are not directly reachable")
	fs.BoolVar(&cfg.ForceRelay, "force-relay", cfg.ForceRelay, "userspace: always use the relay, never a direct path")
	fs.StringVar(&cfg.Share, "share", cfg.Share, "userspace: share local services for remote sessions, e.g. rdp,ssh,http:3000")
	return cfg, fs
}

func loadEnrolled(cfg *config.Config) (*identity.Identity, error) {
	id, err := identity.LoadOrCreate(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	if !id.Enrolled() {
		return nil, fmt.Errorf("not enrolled; run `nexlink-agent enroll` first")
	}
	if cfg.ServerURL == "" {
		cfg.ServerURL = id.State.ServerURL
	}
	return id, cfg.Validate()
}

func cmdEnroll(ctx context.Context, args []string) error {
	cfg, fs := commonFlags("enroll", args)
	_ = fs.Parse(args)
	if err := cfg.Validate(); err != nil {
		return err
	}
	id, err := identity.LoadOrCreate(cfg.StateDir)
	if err != nil {
		return err
	}
	if id.Enrolled() {
		return fmt.Errorf("already enrolled as device %s; use a fresh --state-dir to enroll again", id.State.DeviceID)
	}
	// The token is never accepted as a flag (it would land in shell history / ps).
	token := os.Getenv("NEXLINK_ENROLLMENT_TOKEN")
	if token == "" {
		fmt.Fprint(os.Stderr, "enrollment token: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return fmt.Errorf("read token: %w", err)
		}
		token = strings.TrimSpace(line)
	}
	c := transport.New(cfg.ServerURL, id, "")
	res, err := enrollment.Enroll(ctx, c, id, token, config.Version)
	if err != nil {
		return err
	}
	fmt.Printf("enrolled as %q (%s)\n  network  %s %s\n  address  %s\n  identity %s\n", res.DeviceName, res.DeviceID, res.Network.Name, res.Network.CIDR, res.Address, res.IdentityFingerprint)
	fmt.Println("next: `nexlink-agent run`. No host network settings were changed.")
	return nil
}

func cmdRun(ctx context.Context, args []string, _ *slog.Logger) error {
	cfg, fs := commonFlags("run", args)
	_ = fs.Parse(args)
	return runAgent(ctx, cfg, slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// runAgent is shared by `run` and the Windows service. Its log lines go to
// out and are also streamed to the console's "agent console" panel.
func runAgent(ctx context.Context, cfg *config.Config, out slog.Handler) error {
	id, err := loadEnrolled(cfg)
	if err != nil {
		return err
	}
	events := agent.NewEventBuffer(500)
	log := agent.NewEventLogger(out, events)
	if cfg.Userspace {
		return runUserspace(ctx, cfg, id, log, events)
	}
	if cfg.Privileged {
		log.Warn("PRIVILEGED MODE ENABLED: approved refresh_vpn_config commands will modify WireGuard interface " + cfg.Interface)
	} else {
		log.Info("safe mode: read-only inspection; no host network changes will be made")
	}
	a := agent.New(*cfg, id, wireguard.NewInspector(), wireguard.NewApplier(cfg.Privileged, id.WireGuardPrivateKey()), log)
	a.Events = events
	return a.Run(ctx)
}

func cmdStatus(ctx context.Context, args []string) error {
	cfg, fs := commonFlags("status", args)
	_ = fs.Parse(args)
	id, err := identity.LoadOrCreate(cfg.StateDir)
	if err != nil {
		return err
	}
	st := wireguard.NewInspector().Inspect(ctx, cfg.Interface)
	out := map[string]any{
		"enrolled":           id.Enrolled(),
		"state":              id.State,
		"identityPublicKey":  id.PublicKey(),
		"wireguardPublicKey": id.WireGuardPublicKey(),
		"interface":          st,
		"privilegedEnabled":  cfg.Privileged,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func cmdProbe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	target := fs.String("target", "", "host:port")
	count := fs.Int("count", 5, "attempts (max 20)")
	_ = fs.Parse(args)
	if *target == "" {
		return fmt.Errorf("--target required")
	}
	r := connectivity.TCPProbe(ctx, *target, *count, 2*time.Second, 250*time.Millisecond)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(map[string]any{"result": r, "measurements": r.Measurements("control_plane", nil)})
}

// cmdApply is the explicit, operator-initiated way to push the desired peer set
// onto the local interface. It refuses to run unless privileged mode is on.
func cmdApply(ctx context.Context, args []string, log *slog.Logger) error {
	cfg, fs := commonFlags("apply", args)
	dry := fs.Bool("dry-run", false, "print the desired config without applying")
	_ = fs.Parse(args)
	id, err := loadEnrolled(cfg)
	if err != nil {
		return err
	}
	a := agent.New(*cfg, id, wireguard.NewInspector(), wireguard.NewApplier(cfg.Privileged, id.WireGuardPrivateKey()), log)
	desired, err := a.Executor().FetchDesired(ctx)
	if err != nil {
		return err
	}
	wg, err := desired.ToWireGuard(platform.LocalSubnets(cfg.Interface))
	if err != nil {
		return err
	}
	if err := wireguard.ValidateDesired(wg); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(wg, "", "  ")
	fmt.Println(string(b))
	if *dry {
		return nil
	}
	v, err := a.Executor().ApplyDesired(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("applied config v%d to %s and verified the peer set; reporting telemetry…\n", v, cfg.Interface)
	return a.SendTelemetry(ctx)
}
