// Package session provides remote sessions (Remote Desktop, SSH, VNC, web
// apps) between devices of one network, over their WireGuard tunnel.
//
// Two halves, both inside a running userspace agent:
//
//   - Share (on the device being reached): for each service its owner chose
//     with --share, listen on the device's tunnel address and forward each
//     connection to 127.0.0.1:<port> on that host. Only tunnel peers can reach
//     these listeners; nothing is opened on the host's real network.
//   - Gateway (on the operator's device): a localhost-only API, protected by a
//     random token kept in the user's profile. `nexlink-agent session <peer>
//     rdp` asks it for a local port that forwards through the tunnel, then
//     starts the client (mstsc, ssh, a browser) against 127.0.0.1:<port>.
//
// The traffic is end-to-end encrypted by WireGuard, also when it travels
// through the relay. Every session is logged by both agents, and those log
// lines reach each device's agent console in the web portal.
package session

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nexlink/networking-agent/internal/telemetry"
)

// Known maps service names to their standard ports.
var Known = map[string]int{"rdp": 3389, "ssh": 22, "vnc": 5900, "http": 80, "https": 443}

// ParseShare parses a --share value: "rdp,ssh", "http:3000", "tcp:8080" or "8080".
func ParseShare(s string) ([]telemetry.Service, error) {
	var out []telemetry.Service
	seen := map[int]bool{}
	for _, item := range strings.Split(s, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item == "" {
			continue
		}
		name, portStr, hasPort := strings.Cut(item, ":")
		if !hasPort {
			if n, err := strconv.Atoi(name); err == nil {
				name, portStr, hasPort = "tcp", strconv.Itoa(n), true
			}
		}
		port, known := Known[name]
		if !known && name != "tcp" {
			return nil, fmt.Errorf("unknown service %q (use rdp, ssh, vnc, http, https or tcp:<port>)", name)
		}
		if hasPort {
			p, err := strconv.Atoi(portStr)
			if err != nil || p < 1 || p > 65535 {
				return nil, fmt.Errorf("bad port in %q", item)
			}
			port = p
		} else if name == "tcp" {
			return nil, fmt.Errorf("tcp needs a port, e.g. tcp:8080")
		}
		if seen[port] {
			continue
		}
		seen[port] = true
		out = append(out, telemetry.Service{Name: name, Port: port})
	}
	if len(out) > 8 {
		return nil, fmt.Errorf("at most 8 shared services")
	}
	return out, nil
}

// Listen opens a TCP listener on the tunnel side for a port.
type Listen func(port int) (net.Listener, error)

// Share exposes each service on the tunnel and forwards to 127.0.0.1:<port>.
// It returns once every listener is open; they close when ctx ends.
func Share(ctx context.Context, listen Listen, svcs []telemetry.Service, log *slog.Logger) error {
	for _, s := range svcs {
		ln, err := listen(s.Port)
		if err != nil {
			return fmt.Errorf("share %s on tunnel port %d: %w", s.Name, s.Port, err)
		}
		go func() {
			<-ctx.Done()
			ln.Close()
		}()
		go func(s telemetry.Service) {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go serveShared(c, s, log)
			}
		}(s)
		log.Info("sharing for remote sessions", "service", s.Name, "port", s.Port, "reachable_from", "tunnel peers only")
	}
	return nil
}

func serveShared(c net.Conn, s telemetry.Service, log *slog.Logger) {
	defer c.Close()
	from := c.RemoteAddr().String()
	local, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port)), 5*time.Second)
	if err != nil {
		log.Warn("remote session refused: nothing is listening locally", "service", s.Name, "port", s.Port, "from", from)
		return
	}
	start := time.Now()
	log.Info("remote session opened", "service", s.Name, "from", from)
	up, down := pipe(c, local)
	log.Info("remote session closed", "service", s.Name, "from", from, "duration", time.Since(start).Round(time.Second).String(), "bytes_in", up, "bytes_out", down)
}

// pipe copies both ways until either side closes; returns bytes a→b, b→a.
func pipe(a, b net.Conn) (int64, int64) {
	var ab, ba int64
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		ab, _ = io.Copy(b, a)
		closeWrite(b)
	}()
	go func() {
		defer wg.Done()
		ba, _ = io.Copy(a, b)
		closeWrite(a)
	}()
	wg.Wait()
	b.Close()
	return ab, ba
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

// Peer is a device this agent can open sessions to.
type Peer struct {
	DeviceID string              `json:"deviceId"`
	Name     string              `json:"name"`
	IP       string              `json:"ip"`
	Online   bool                `json:"online"` // fresh WireGuard handshake
	Path     string              `json:"path"`   // direct | relay | none
	Services []telemetry.Service `json:"services"`
}

// Resolve finds a peer by name (case-insensitive), tunnel IP or device id,
// and the port for a service it shares.
func Resolve(peers []Peer, who, service string) (Peer, telemetry.Service, error) {
	var p *Peer
	for i := range peers {
		q := peers[i]
		if strings.EqualFold(q.Name, who) || q.IP == who || q.DeviceID == who {
			p = &peers[i]
			break
		}
	}
	if p == nil {
		names := make([]string, 0, len(peers))
		for _, q := range peers {
			names = append(names, q.Name)
		}
		sort.Strings(names)
		return Peer{}, telemetry.Service{}, fmt.Errorf("no device %q in your network (known: %s)", who, strings.Join(names, ", "))
	}
	if len(p.Services) == 0 {
		return *p, telemetry.Service{}, fmt.Errorf("%s shares nothing; on %s run the agent with --share rdp (or ssh, vnc, ...)", p.Name, p.Name)
	}
	if service == "" {
		return *p, p.Services[0], nil
	}
	want := strings.ToLower(service)
	for _, s := range p.Services {
		if s.Name == want || strconv.Itoa(s.Port) == want {
			return *p, s, nil
		}
	}
	shared := make([]string, 0, len(p.Services))
	for _, s := range p.Services {
		shared = append(shared, fmt.Sprintf("%s:%d", s.Name, s.Port))
	}
	return *p, telemetry.Service{}, fmt.Errorf("%s does not share %s (it shares %s)", p.Name, service, strings.Join(shared, ", "))
}

// forward is one local listener that tunnels to a peer's service.
type forward struct {
	ln     net.Listener
	active atomic.Int32
	last   atomic.Int64
}

const forwardIdle = 30 * time.Minute

func (g *Gateway) openForward(ctx context.Context, p Peer, s telemetry.Service) (int, error) {
	key := net.JoinHostPort(p.IP, strconv.Itoa(s.Port))
	g.mu.Lock()
	defer g.mu.Unlock()
	if f, ok := g.forwards[key]; ok {
		return f.ln.Addr().(*net.TCPAddr).Port, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	f := &forward{ln: ln}
	f.last.Store(time.Now().UnixNano())
	g.forwards[key] = f
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.active.Add(1)
			go func() {
				defer f.active.Add(-1)
				defer c.Close()
				dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				remote, err := g.Dial(dctx, key)
				cancel()
				if err != nil {
					g.Log.Warn("remote session failed: peer not reachable through the tunnel", "peer", p.Name, "service", s.Name, "err", err)
					return
				}
				start := time.Now()
				g.Log.Info("remote session started", "peer", p.Name, "service", s.Name, "path", p.Path)
				up, down := pipe(c, remote)
				f.last.Store(time.Now().UnixNano())
				g.Log.Info("remote session ended", "peer", p.Name, "service", s.Name, "duration", time.Since(start).Round(time.Second).String(), "bytes_out", up, "bytes_in", down)
			}()
		}
	}()
	// Close forwards nobody used for a while.
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				ln.Close()
				return
			case <-t.C:
				if f.active.Load() == 0 && time.Since(time.Unix(0, f.last.Load())) > forwardIdle {
					g.mu.Lock()
					delete(g.forwards, key)
					g.mu.Unlock()
					ln.Close()
					return
				}
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
