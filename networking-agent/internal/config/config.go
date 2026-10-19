// Package config loads agent configuration from environment variables and flags.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Version is the agent version reported to the control plane.
const Version = "0.2.0"

type Config struct {
	ServerURL         string
	StateDir          string
	Interface         string
	HeartbeatInterval time.Duration
	TelemetryInterval time.Duration
	// Privileged gates every operation that changes host network state. It is
	// false unless NEXLINK_ENABLE_PRIVILEGED=true is set explicitly.
	Privileged bool
	AllowHTTP  bool
	// TCP port used for peer reachability probes over the tunnel. Each agent
	// answers on its own tunnel address only (see connectivity.StartResponder).
	ProbePort int
	// WireGuard UDP listen port. Advertised to peers as part of endpoint
	// candidates even before the tunnel exists, and written by export-config.
	ListenPort int
	// Userspace runs the tunnel inside the agent (wireguard-go): no WireGuard
	// app and no Administrator rights needed. NexLink traffic (handshakes,
	// probes, approved tests) uses the tunnel; other apps do not.
	Userspace bool
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(env(key, "")); err == nil {
		return v
	}
	return def
}

func defaultStateDir() string {
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "nexlink-agent")
	}
	return ".nexlink-agent"
}

// FromEnv builds a Config from NEXLINK_* environment variables.
func FromEnv() Config {
	hb := envInt("NEXLINK_HEARTBEAT_SECONDS", 30)
	return Config{
		ServerURL:         env("NEXLINK_SERVER", ""),
		StateDir:          env("NEXLINK_STATE_DIR", defaultStateDir()),
		Interface:         env("NEXLINK_INTERFACE", "nexlink0"),
		HeartbeatInterval: time.Duration(hb) * time.Second,
		TelemetryInterval: time.Duration(envInt("NEXLINK_TELEMETRY_SECONDS", hb*2)) * time.Second,
		Privileged:        env("NEXLINK_ENABLE_PRIVILEGED", "false") == "true",
		AllowHTTP:         env("NEXLINK_ALLOW_HTTP", "false") == "true",
		ProbePort:         envInt("NEXLINK_PROBE_TCP_PORT", 7946),
		ListenPort:        envInt("NEXLINK_LISTEN_PORT", 51820),
		Userspace:         env("NEXLINK_USERSPACE", "false") == "true",
	}
}

// Validate checks the configuration. Plain HTTP is accepted only for loopback
// servers unless AllowHTTP is set (requests are signed, but not encrypted).
func (c Config) Validate() error {
	if c.ServerURL == "" {
		return errors.New("server URL is required (--server or NEXLINK_SERVER)")
	}
	u, err := url.Parse(c.ServerURL)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid server URL %q", c.ServerURL)
	}
	switch u.Scheme {
	case "https":
	case "http":
		host := u.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) && !c.AllowHTTP {
			return errors.New("refusing plain http to a non-loopback server; use https or set NEXLINK_ALLOW_HTTP=true for a lab network")
		}
	default:
		return fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if c.HeartbeatInterval < 5*time.Second {
		return errors.New("heartbeat interval must be >= 5s")
	}
	if c.ProbePort < 1 || c.ProbePort > 65535 || c.ListenPort < 1 || c.ListenPort > 65535 {
		return errors.New("probe or listen port out of range")
	}
	return nil
}
