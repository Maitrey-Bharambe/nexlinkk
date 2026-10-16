package connectivity

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

// Category: unit test against loopback sockets only.

func TestProbeOpenPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	r := TCPProbe(context.Background(), ln.Addr().String(), 4, time.Second, 0)
	if r.Attempts != 4 || r.Successes != 4 {
		t.Fatalf("got %+v", r)
	}
	ms := r.Measurements("control_plane", nil)
	for _, m := range ms {
		if !m.Valid || m.Value == nil {
			t.Fatalf("expected valid %s", m.Type)
		}
	}
	if *ms[2].Value != 0 {
		t.Fatalf("loss = %v, want 0", *ms[2].Value)
	}
}

func TestRefusedCountsAsReachable(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close() // nothing listening now → RST
	r := TCPProbe(context.Background(), addr, 3, time.Second, 0)
	if r.Successes != 3 {
		t.Fatalf("refused connections should prove reachability: %+v", r)
	}
}

func TestUnreachableIsLossNotFakeRTT(t *testing.T) {
	// TEST-NET-1 (RFC 5737) is not routed; connects time out.
	r := TCPProbe(context.Background(), "192.0.2.1:9", 3, 200*time.Millisecond, 0)
	ms := r.Measurements("peer", nil)
	byType := map[string]int{}
	for i, m := range ms {
		byType[m.Type] = i
	}
	rtt := ms[byType["rtt"]]
	if rtt.Valid || rtt.Value != nil {
		t.Fatalf("rtt must be unavailable, got %+v", rtt)
	}
	b, _ := json.Marshal(rtt)
	if !strings.Contains(string(b), `"value":null`) {
		t.Fatalf("unavailable must serialize value:null, got %s", b)
	}
	if r.Successes == 0 {
		loss := ms[byType["packet_loss"]]
		if !loss.Valid || *loss.Value != 100 {
			t.Fatalf("expected 100%% loss, got %+v", loss)
		}
	}
}

func TestProbeBounds(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	r := TCPProbe(context.Background(), ln.Addr().String(), 500, time.Hour, 0)
	if r.Attempts > MaxCount {
		t.Fatalf("count not clamped: %d", r.Attempts)
	}
	few := Result{Attempts: 2, Successes: 2, RTTs: []time.Duration{time.Millisecond, 2 * time.Millisecond}, At: time.Now()}
	for _, m := range few.Measurements("control_plane", nil) {
		if m.Type == "packet_loss" && m.Valid {
			t.Fatal("loss from 2 samples must be unavailable")
		}
	}
}
