package connectivity

import (
	"context"
	"testing"
	"time"
)

func TestResponderAnswersProbes(t *testing.T) {
	ln, err := StartResponder("127.0.0.1", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	r := TCPProbe(context.Background(), ln.Addr().String(), 3, time.Second, 0)
	if r.Successes != 3 {
		t.Fatalf("got %+v", r)
	}
}

func TestResponderNeedsAnIPv4Address(t *testing.T) {
	if _, err := StartResponder("", 7946); err == nil {
		t.Fatal("expected error without a tunnel address")
	}
	// An address this host does not own (tunnel not up yet) must fail, not bind elsewhere.
	if ln, err := StartResponder("10.254.254.254", 0); err == nil {
		ln.Close()
		t.Fatal("bound to an address the host does not have")
	}
}
