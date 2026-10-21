package session

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Dialer opens a TCP connection through the tunnel.
type Dialer func(ctx context.Context, addr string) (net.Conn, error)

// Gateway is the operator-side half: a localhost API that hands out local
// ports forwarding through the tunnel.
type Gateway struct {
	Dial  Dialer
	Peers func() []Peer
	// Refresh, when set, re-reads the peer list from the control plane; used
	// once before refusing a request (a peer may have just started sharing).
	Refresh func()
	Log     *slog.Logger

	mu       sync.Mutex
	forwards map[string]*forward
}

// Info is what a running agent publishes so `nexlink-agent session` can find it.
type Info struct {
	Addr     string `json:"addr"`
	Token    string `json:"token"`
	DeviceID string `json:"deviceId"`
	PID      int    `json:"pid"`
}

const infoFile = "session-gateway.json"

// DefaultInfoPath is a per-user location shared by every agent the user runs
// (on Windows %LOCALAPPDATA%\NexLink, the folder the join script installs to).
func DefaultInfoPath() string {
	if d, err := os.UserCacheDir(); err == nil {
		return filepath.Join(d, "NexLink", infoFile)
	}
	return infoFile
}

// InfoPathIn is the copy kept in an agent's own state directory.
func InfoPathIn(stateDir string) string { return filepath.Join(stateDir, infoFile) }

// ForwardRequest / ForwardResponse are the gateway's API.
type ForwardRequest struct {
	Peer    string `json:"peer"`
	Service string `json:"service"`
}

type ForwardResponse struct {
	LocalPort int    `json:"localPort"`
	Peer      Peer   `json:"peer"`
	Service   string `json:"service"`
	Port      int    `json:"port"`
}

// Start serves the API on 127.0.0.1 and writes Info to the given paths
// (readable by this user only). It stops when ctx ends.
func (g *Gateway) Start(ctx context.Context, deviceID string, infoPaths ...string) error {
	g.forwards = map[string]*forward{}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("Authorization")
			if subtle.ConstantTimeCompare([]byte(got), []byte("Bearer "+token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			// Browsers cannot attach the token, but refuse anything that looks like one anyway.
			if r.Header.Get("Origin") != "" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/v1/peers", auth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, g.Peers())
	}))
	mux.HandleFunc("/v1/forward", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req ForwardRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
			return
		}
		p, s, err := Resolve(g.Peers(), req.Peer, req.Service)
		if err != nil && g.Refresh != nil {
			g.Refresh()
			p, s, err = Resolve(g.Peers(), req.Peer, req.Service)
		}
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		port, err := g.openForward(ctx, p, s)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		g.Log.Info("remote session requested", "peer", p.Name, "service", s.Name, "local_port", port, "path", p.Path)
		writeJSON(w, http.StatusOK, ForwardResponse{LocalPort: port, Peer: p, Service: s.Name, Port: s.Port})
	}))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()

	info, _ := json.Marshal(Info{Addr: ln.Addr().String(), Token: token, DeviceID: deviceID, PID: os.Getpid()})
	for _, p := range infoPaths {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err == nil {
			_ = os.WriteFile(p, info, 0o600)
		}
	}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
		for _, p := range infoPaths {
			// Only remove what is still ours (another agent may have taken over the shared file).
			if b, err := os.ReadFile(p); err == nil && bytes.Equal(b, info) {
				_ = os.Remove(p)
			}
		}
	}()
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// LoadInfo reads a running agent's gateway address and token.
func LoadInfo(path string) (Info, error) {
	var info Info
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return info, fmt.Errorf("no running NexLink agent found (%s); start it first, e.g. with the join line or `nexlink-agent run --userspace`", path)
		}
		return info, err
	}
	return info, json.Unmarshal(b, &info)
}

// Call sends one request to a running agent's gateway.
func Call(info Info, method, path string, in, out any) error {
	var body bytes.Buffer
	if in != nil {
		_ = json.NewEncoder(&body).Encode(in)
	}
	req, err := http.NewRequest(method, "http://"+info.Addr+path, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("the NexLink agent is not running (start it first): %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		return errors.New(e.Error)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
