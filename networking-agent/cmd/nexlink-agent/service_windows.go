//go:build windows

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/debug"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/identity"
)

const serviceName = "NexLinkAgent"

func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// cmdInstall registers the agent as an auto-start Windows service that runs
// `nexlink-agent service --state-dir <dir> …` as LocalSystem. Needs an
// Administrator terminal. The device must already be enrolled.
func cmdInstall(args []string) error {
	cfg, fs := commonFlags("install", args)
	_ = fs.Parse(args)
	dir, err := filepath.Abs(cfg.StateDir)
	if err != nil {
		return err
	}
	id, err := identity.LoadOrCreate(dir)
	if err != nil {
		return err
	}
	if !id.Enrolled() {
		return fmt.Errorf("%s is not enrolled; run `nexlink-agent enroll --state-dir %s` first", dir, dir)
	}
	server := cfg.ServerURL
	if server == "" {
		server = id.State.ServerURL
	}
	check := *cfg
	check.ServerURL = server
	if err := check.Validate(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot open the service manager (run this terminal as Administrator): %w", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("service %s already exists; run `nexlink-agent uninstall` first", serviceName)
	}

	svcArgs := []string{"service", "--state-dir", dir, "--server", server, "--interface", cfg.Interface}
	if cfg.AllowHTTP {
		svcArgs = append(svcArgs, "--allow-http")
	}
	if cfg.Privileged {
		svcArgs = append(svcArgs, "--enable-privileged")
	}
	if cfg.Userspace {
		svcArgs = append(svcArgs, "--userspace", "--listen-port", strconv.Itoa(cfg.ListenPort))
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName: "NexLink Agent",
		Description: "NexLink networking agent: heartbeats, telemetry, WireGuard status and approved commands.",
		StartType:   mgr.StartAutomatic,
	}, svcArgs...)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 10 * time.Second}}, 86400)
	if err := s.Start(); err != nil {
		return fmt.Errorf("service installed but failed to start: %w", err)
	}
	fmt.Printf("installed and started %q (starts automatically with Windows)\n  device   %s (%s)\n  server   %s\n  log file %s\n",
		serviceName, id.State.DeviceName, id.State.DeviceID, server, filepath.Join(dir, "agent.log"))
	fmt.Println("You can close this window: the agent keeps running. Watch it on the device page → agent console.")
	return nil
}

func cmdUninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot open the service manager (run this terminal as Administrator): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service %s is not installed", serviceName)
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		_, _ = s.Control(svc.Stop)
		for i := 0; i < 20; i++ {
			time.Sleep(500 * time.Millisecond)
			if st, err := s.Query(); err != nil || st.State == svc.Stopped {
				break
			}
		}
	}
	if err := s.Delete(); err != nil {
		return err
	}
	fmt.Printf("stopped and removed %q. Enrollment and keys are kept in the state directory.\n", serviceName)
	return nil
}

func cmdServiceStatus() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot open the service manager (run this terminal as Administrator): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Printf("%s: not installed\n", serviceName)
		return nil
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	names := map[svc.State]string{svc.Stopped: "stopped", svc.StartPending: "starting", svc.StopPending: "stopping", svc.Running: "running", svc.Paused: "paused"}
	c, _ := s.Config()
	fmt.Printf("%s: %s\n  command %s\n", serviceName, names[st.State], c.BinaryPathName)
	return nil
}

type agentService struct{ args []string }

// runService runs under the Service Control Manager, or in this console with --debug.
func runService(args []string) error {
	dbg := false
	rest := args[:0:0]
	for _, a := range args {
		if a == "--debug" {
			dbg = true
			continue
		}
		rest = append(rest, a)
	}
	h := &agentService{args: rest}
	if dbg {
		return debug.Run(serviceName, h)
	}
	return svc.Run(serviceName, h)
}

func (h *agentService) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	cfg, fs := commonFlags("service", h.args)
	fs.Init("service", flag.ContinueOnError)
	if err := fs.Parse(h.args); err != nil {
		return true, 1
	}
	logOut, closeLog := openServiceLog(cfg)
	defer closeLog()
	base := slog.NewJSONHandler(logOut, &slog.HandlerOptions{Level: slog.LevelInfo})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runAgent(ctx, cfg, base) }()

	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			cancel()
			if err != nil {
				slog.New(base).Error("agent stopped", "err", err)
				return true, 2
			}
			return false, 0
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(10 * time.Second):
				}
				return false, 0
			}
		}
	}
}

// openServiceLog appends to <state-dir>/agent.log, starting fresh past 5 MB.
func openServiceLog(cfg *config.Config) (io.Writer, func()) {
	path := filepath.Join(cfg.StateDir, "agent.log")
	if fi, err := os.Stat(path); err == nil && fi.Size() > 5<<20 {
		_ = os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return io.Discard, func() {}
	}
	return f, func() { f.Close() }
}
