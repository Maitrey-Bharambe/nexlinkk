// Package relay carries WireGuard packets through the control plane when two
// devices cannot reach each other directly (NAT, CGNAT, UDP blocked).
//
// The agent keeps one WebSocket open to /api/v1/agent/relay, authenticated
// with the same Ed25519 request signature as every other agent call. A frame
// is [12-byte peer device id][one WireGuard UDP payload]. Payloads are
// WireGuard ciphertext: the relay forwards them but cannot read or forge them.
package relay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/net/websocket"

	"github.com/nexlink/networking-agent/internal/transport"
)

// Path is the relay endpoint on the control plane.
const Path = "/api/v1/agent/relay"

// IDLen is the length of a raw device id (MongoDB ObjectId).
const IDLen = 12

const (
	maxFrame  = IDLen + 2048
	keepalive = 20 * time.Second
)

// ErrNotConnected is returned by Send while the relay socket is down.
var ErrNotConnected = errors.New("relay not connected")

// Packet is one WireGuard payload from (or to) a peer device.
type Packet struct {
	Peer [IDLen]byte
	Data []byte
}

// ParseID decodes a 24-hex-digit device id.
func ParseID(s string) ([IDLen]byte, error) {
	var id [IDLen]byte
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != IDLen {
		return id, fmt.Errorf("invalid device id %q", s)
	}
	copy(id[:], b)
	return id, nil
}

// Client is a self-reconnecting relay connection.
type Client struct {
	serverURL string
	deviceID  string
	signer    transport.Signer
	log       *slog.Logger

	in        chan Packet
	out       chan []byte
	connected atomic.Bool
	Stats     struct{ Sent, Received, Dropped atomic.Int64 }
}

func New(serverURL, deviceID string, signer transport.Signer, log *slog.Logger) *Client {
	return &Client{
		serverURL: strings.TrimRight(serverURL, "/"),
		deviceID:  deviceID,
		signer:    signer,
		log:       log,
		in:        make(chan Packet, 512),
		out:       make(chan []byte, 512),
	}
}

// Incoming delivers packets received from peers.
func (c *Client) Incoming() <-chan Packet { return c.in }

// Connected reports whether the relay socket is up right now.
func (c *Client) Connected() bool { return c.connected.Load() }

// Send queues one packet for a peer. Like UDP, it drops instead of blocking
// when the link is down or the queue is full. data is copied.
func (c *Client) Send(peer [IDLen]byte, data []byte) error {
	if !c.connected.Load() {
		c.Stats.Dropped.Add(1)
		return ErrNotConnected
	}
	if len(data)+IDLen > maxFrame {
		return fmt.Errorf("relay: packet too large (%d bytes)", len(data))
	}
	f := make([]byte, IDLen+len(data))
	copy(f, peer[:])
	copy(f[IDLen:], data)
	select {
	case c.out <- f:
		return nil
	default:
		c.Stats.Dropped.Add(1)
		return nil
	}
}

// Run keeps the relay connected until ctx ends.
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		c.log.Warn("relay disconnected; retrying", "err", err, "in", backoff.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (c *Client) dial() (*websocket.Conn, error) {
	u, err := url.Parse(c.serverURL)
	if err != nil {
		return nil, err
	}
	origin := u.String()
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return nil, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + Path
	cfg, err := websocket.NewConfig(u.String(), origin)
	if err != nil {
		return nil, err
	}
	nonceRaw := make([]byte, 16)
	_, _ = rand.Read(nonceRaw)
	nonce := base64.RawURLEncoding.EncodeToString(nonceRaw)
	ts := time.Now().UnixMilli()
	cfg.Header.Set("User-Agent", "nexlink-agent")
	cfg.Header.Set("X-NexLink-Device", c.deviceID)
	cfg.Header.Set("X-NexLink-Timestamp", strconv.FormatInt(ts, 10))
	cfg.Header.Set("X-NexLink-Nonce", nonce)
	cfg.Header.Set("X-NexLink-Signature", c.signer.Sign([]byte(transport.CanonicalRequest("GET", Path, ts, nonce, c.deviceID, nil))))
	return websocket.DialConfig(cfg)
}

func (c *Client) session(ctx context.Context) error {
	ws, err := c.dial()
	if err != nil {
		return err
	}
	ws.MaxPayloadBytes = maxFrame
	c.connected.Store(true)
	c.log.Info("relay connected", "note", "fallback path for peers this PC cannot reach directly")
	defer c.connected.Store(false)

	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		ws.Close()
	}()

	// Single writer: data frames plus a keepalive the relay uses for liveness.
	writeErr := make(chan error, 1)
	go func() {
		t := time.NewTicker(keepalive)
		defer t.Stop()
		ping := make([]byte, IDLen)
		for {
			var f []byte
			select {
			case <-done:
				return
			case f = <-c.out:
			case <-t.C:
				f = ping
			}
			if err := websocket.Message.Send(ws, f); err != nil {
				writeErr <- err
				ws.Close()
				return
			}
			if len(f) > IDLen {
				c.Stats.Sent.Add(1)
			}
		}
	}()

	for {
		var f []byte
		if err := websocket.Message.Receive(ws, &f); err != nil {
			select {
			case werr := <-writeErr:
				return werr
			default:
				return err
			}
		}
		if len(f) <= IDLen {
			continue
		}
		var p Packet
		copy(p.Peer[:], f[:IDLen])
		p.Data = f[IDLen:]
		select {
		case c.in <- p:
			c.Stats.Received.Add(1)
		default:
			c.Stats.Dropped.Add(1)
		}
	}
}
