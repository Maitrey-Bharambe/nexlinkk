package wireguard

import (
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"golang.zx2c4.com/wireguard/conn"

	"github.com/nexlink/networking-agent/internal/relay"
)

// RelayPrefix marks a WireGuard endpoint that is reached through the control
// plane's relay: "relay:<peer device id>".
const RelayPrefix = "relay:"

// IsRelayEndpoint reports whether ep is a "relay:<24 hex>" endpoint.
func IsRelayEndpoint(ep string) bool {
	if !strings.HasPrefix(ep, RelayPrefix) {
		return false
	}
	_, err := relay.ParseID(ep[len(RelayPrefix):])
	return err == nil
}

// relayEndpoint is a peer reached through the relay. WireGuard treats it like
// any other endpoint: the handshake and every packet stay end-to-end
// encrypted; only the transport underneath changes.
type relayEndpoint struct{ id [relay.IDLen]byte }

func (e *relayEndpoint) ClearSrc()           {}
func (e *relayEndpoint) SrcToString() string { return "" }
func (e *relayEndpoint) DstToString() string { return RelayPrefix + hex.EncodeToString(e.id[:]) }
func (e *relayEndpoint) DstToBytes() []byte  { return e.id[:] }
func (e *relayEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }

// DstIP gives each relayed peer a stable, never-routable address so
// wireguard-go's per-source handshake rate limiter still works.
func (e *relayEndpoint) DstIP() netip.Addr {
	var b [16]byte
	b[0] = 0xfd
	copy(b[4:], e.id[:])
	return netip.AddrFrom16(b)
}

// RelayTransport is what MuxBind needs from the relay (a *relay.Client).
type RelayTransport interface {
	Send(peer [relay.IDLen]byte, data []byte) error
	Incoming() <-chan relay.Packet
}

// MuxBind sends to "ip:port" endpoints over UDP (the normal, direct path) and
// to "relay:<id>" endpoints over the relay. It receives from both.
type MuxBind struct {
	std   conn.Bind
	relay RelayTransport

	mu     sync.Mutex
	closed chan struct{}
}

// NewMuxBind wraps the standard UDP bind; r may be nil (direct only).
func NewMuxBind(r RelayTransport) *MuxBind {
	return &MuxBind{std: conn.NewDefaultBind(), relay: r}
}

func (b *MuxBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.std.Open(port)
	if err != nil || b.relay == nil {
		return fns, actual, err
	}
	closed := make(chan struct{})
	b.mu.Lock()
	b.closed = closed
	b.mu.Unlock()
	in := b.relay.Incoming()
	recv := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		var p relay.Packet
		select {
		case <-closed:
			return 0, net.ErrClosed
		case p = <-in:
		}
		n := 0
		for {
			sizes[n] = copy(packets[n], p.Data)
			eps[n] = &relayEndpoint{id: p.Peer}
			n++
			if n == len(packets) {
				return n, nil
			}
			select {
			case p = <-in:
			default:
				return n, nil
			}
		}
	}
	return append(fns, recv), actual, nil
}

func (b *MuxBind) Close() error {
	b.mu.Lock()
	if b.closed != nil {
		close(b.closed)
		b.closed = nil
	}
	b.mu.Unlock()
	return b.std.Close()
}

func (b *MuxBind) SetMark(mark uint32) error { return b.std.SetMark(mark) }

func (b *MuxBind) BatchSize() int { return b.std.BatchSize() }

func (b *MuxBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	re, ok := ep.(*relayEndpoint)
	if !ok {
		return b.std.Send(bufs, ep)
	}
	if b.relay == nil {
		return errors.New("relay endpoint but no relay configured")
	}
	var err error
	for _, buf := range bufs {
		if e := b.relay.Send(re.id, buf); e != nil {
			err = e
		}
	}
	return err
}

func (b *MuxBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if strings.HasPrefix(s, RelayPrefix) {
		id, err := relay.ParseID(s[len(RelayPrefix):])
		if err != nil {
			return nil, err
		}
		return &relayEndpoint{id: id}, nil
	}
	return b.std.ParseEndpoint(s)
}
