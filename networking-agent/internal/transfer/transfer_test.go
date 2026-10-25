package transfer

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func listen(t *testing.T) (net.Listener, chan Received) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan Received, 1)
	go Serve(ln, func(r Received) { got <- r })
	t.Cleanup(func() { ln.Close() })
	return ln, got
}

func TestSendVerifiedBySink(t *testing.T) {
	ln, got := listen(t)
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var last int64
	r, err := Send(context.Background(), c, 3<<20, func(s int64) { last = s })
	if err != nil {
		t.Fatal(err)
	}
	if !r.IntegrityMatch || r.Bytes != 3<<20 || r.PeerBytes != 3<<20 || last != 3<<20 {
		t.Fatalf("unexpected result %+v (last progress %d)", r, last)
	}
	if r.BitsPerSecond() <= 0 {
		t.Fatal("throughput must be positive")
	}
	select {
	case rec := <-got:
		if rec.Bytes != 3<<20 {
			t.Fatalf("sink saw %d bytes", rec.Bytes)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sink did not report the transfer")
	}
}

func TestSizeBounds(t *testing.T) {
	ln, _ := listen(t)
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := Send(context.Background(), c, MaxBytes+1, nil); err == nil {
		t.Fatal("oversized transfer must be refused by the sender")
	}
	if _, err := Send(context.Background(), c, 10, nil); err == nil {
		t.Fatal("undersized transfer must be refused by the sender")
	}
}

func TestSinkRejectsOversizeAndGarbage(t *testing.T) {
	ln, _ := listen(t)
	for _, hdr := range [][]byte{
		append([]byte("NXT1"), be(MaxBytes+1)...),
		append([]byte("HTTP"), be(1024)...),
	} {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_, _ = c.Write(hdr)
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if n, _ := io.ReadFull(c, make([]byte, 40)); n != 0 {
			t.Fatalf("sink answered a bad request (%q)", hdr[:4])
		}
		c.Close()
	}
}

func TestCancelledContextStopsSend(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { // a sink that never reads: the send must give up when ctx ends
		c, err := ln.Accept()
		if err == nil {
			time.Sleep(3 * time.Second)
			c.Close()
		}
	}()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := Send(ctx, c, MaxBytes, nil); err == nil {
		t.Fatal("send must fail when the context ends")
	}
}

func be(n uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, n)
	return b
}
