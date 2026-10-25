// Package transfer moves real bytes through the WireGuard tunnel and proves they
// arrived intact. The sink listens only on the tunnel address (inside the
// userspace network stack), so nothing outside the private network can reach it.
//
// Wire format, one transfer per connection:
//
//	client → sink   "NXT1" | uint64 big-endian length | <length bytes>
//	sink → client   uint64 big-endian bytes received   | 32-byte SHA-256 of them
package transfer

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const (
	magic    = "NXT1"
	MinBytes = 1 << 20  // 1 MiB
	MaxBytes = 32 << 20 // 32 MiB — bounded so a test can never become a flood
	chunk    = 64 << 10
	deadline = 3 * time.Minute
)

// PortFor derives the sink port from the probe port, so both peers agree without config.
func PortFor(probePort int) int { return probePort + 1 }

// Received describes one completed incoming transfer (for the sink's log).
type Received struct {
	From     string
	Bytes    int64
	Duration time.Duration
}

// Serve accepts transfers until ln is closed. Each connection is handled on its own goroutine.
func Serve(ln net.Listener, onReceived func(Received)) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			r, err := sink(c)
			if err == nil && onReceived != nil {
				onReceived(r)
			}
		}()
	}
}

func sink(c net.Conn) (Received, error) {
	start := time.Now()
	_ = c.SetDeadline(start.Add(deadline))
	var hdr [12]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return Received{}, err
	}
	if string(hdr[:4]) != magic {
		return Received{}, errors.New("not a transfer request")
	}
	n := int64(binary.BigEndian.Uint64(hdr[4:]))
	if n < 1 || n > MaxBytes {
		return Received{}, fmt.Errorf("transfer size %d out of range", n)
	}
	h := sha256.New()
	got, err := io.CopyN(h, c, n)
	var ack [40]byte
	binary.BigEndian.PutUint64(ack[:8], uint64(got))
	copy(ack[8:], h.Sum(nil))
	if _, werr := c.Write(ack[:]); werr != nil && err == nil {
		err = werr
	}
	return Received{From: c.RemoteAddr().String(), Bytes: got, Duration: time.Since(start)}, err
}

// Result of a completed send.
type Result struct {
	Bytes          int64
	Duration       time.Duration // first byte written → acknowledgement read
	SentSHA256     [32]byte
	PeerBytes      int64
	PeerSHA256     [32]byte
	IntegrityMatch bool
}

// BitsPerSecond is the goodput the transfer achieved.
func (r Result) BitsPerSecond() float64 {
	if r.Duration <= 0 {
		return 0
	}
	return float64(r.Bytes*8) / r.Duration.Seconds()
}

// Send writes n random bytes to an already-dialled sink connection and waits
// for the sink to confirm what it received. progress (optional) is called as bytes go out.
func Send(ctx context.Context, c net.Conn, n int64, progress func(sent int64)) (Result, error) {
	if n < MinBytes || n > MaxBytes {
		return Result{}, fmt.Errorf("transfer size must be %d..%d bytes", MinBytes, MaxBytes)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	} else {
		_ = c.SetDeadline(time.Now().Add(deadline))
	}
	stop := context.AfterFunc(ctx, func() { _ = c.SetDeadline(time.Now()) })
	defer stop()

	// Random, incompressible payload: one random block, each chunk stamped with its index.
	block := make([]byte, chunk)
	if _, err := rand.Read(block); err != nil {
		return Result{}, err
	}
	var hdr [12]byte
	copy(hdr[:4], magic)
	binary.BigEndian.PutUint64(hdr[4:], uint64(n))

	h := sha256.New()
	start := time.Now()
	if _, err := c.Write(hdr[:]); err != nil {
		return Result{}, err
	}
	var sent int64
	for i := uint64(0); sent < n; i++ {
		binary.BigEndian.PutUint64(block[:8], i)
		part := block
		if left := n - sent; left < int64(len(part)) {
			part = part[:left]
		}
		if _, err := c.Write(part); err != nil {
			return Result{}, fmt.Errorf("after %d bytes: %w", sent, err)
		}
		h.Write(part)
		sent += int64(len(part))
		if progress != nil {
			progress(sent)
		}
	}
	var ack [40]byte
	if _, err := io.ReadFull(c, ack[:]); err != nil {
		return Result{}, fmt.Errorf("no confirmation from the peer: %w", err)
	}
	r := Result{Bytes: sent, Duration: time.Since(start), PeerBytes: int64(binary.BigEndian.Uint64(ack[:8]))}
	copy(r.SentSHA256[:], h.Sum(nil))
	copy(r.PeerSHA256[:], ack[8:])
	r.IntegrityMatch = r.PeerBytes == r.Bytes && r.PeerSHA256 == r.SentSHA256
	return r, nil
}
