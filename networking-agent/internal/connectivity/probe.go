// Package connectivity runs bounded, unprivileged reachability probes.
//
// Probes use TCP connect, not ICMP: ICMP needs raw sockets (privileges) and is
// often filtered independently of other traffic. A TCP RST ("connection
// refused") still proves the host answered, so it counts as reachable. Only a
// timeout counts as a lost sample. A failed probe never proves a host is down.
package connectivity

import (
	"context"
	"errors"
	"math"
	"net"
	"syscall"
	"time"

	"github.com/nexlink/networking-agent/internal/telemetry"
)

const (
	MaxCount   = 20
	MaxTimeout = 3 * time.Second
	MinGap     = 100 * time.Millisecond
	// Below this many attempts a loss percentage is statistically meaningless.
	MinLossSamples = 3
)

type Result struct {
	Target    string
	Attempts  int
	Successes int
	RTTs      []time.Duration
	Errors    []string
	At        time.Time
}

func isRefused(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		// 10061 = WSAECONNREFUSED on Windows.
		return errno == syscall.ECONNREFUSED || errno == 10061
	}
	return false
}

// TCPProbe dials addr count times. Count, timeout and gap are clamped so a
// probe can never become a flood.
func TCPProbe(ctx context.Context, addr string, count int, timeout, gap time.Duration) Result {
	if count < 1 {
		count = 1
	}
	if count > MaxCount {
		count = MaxCount
	}
	if timeout <= 0 || timeout > MaxTimeout {
		timeout = MaxTimeout
	}
	if gap < MinGap {
		gap = MinGap
	}
	r := Result{Target: addr, At: time.Now()}
	for i := 0; i < count; i++ {
		if ctx.Err() != nil {
			break
		}
		r.Attempts++
		d := net.Dialer{Timeout: timeout}
		start := time.Now()
		conn, err := d.DialContext(ctx, "tcp", addr)
		rtt := time.Since(start)
		switch {
		case err == nil:
			conn.Close()
			r.Successes++
			r.RTTs = append(r.RTTs, rtt)
		case isRefused(err):
			r.Successes++
			r.RTTs = append(r.RTTs, rtt)
		default:
			r.Errors = append(r.Errors, err.Error())
		}
		if i < count-1 {
			select {
			case <-ctx.Done():
			case <-time.After(gap):
			}
		}
	}
	return r
}

func ms(d time.Duration) float64 { return math.Round(float64(d.Microseconds())/10) / 100 }

// Measurements converts a probe into RTT, jitter and loss measurements,
// marking each one unavailable when the samples do not support it.
func (r Result) Measurements(kind string, ref *string) []telemetry.Measurement {
	t := telemetry.Target{Kind: kind, Ref: ref}
	const src = "tcp_connect"
	out := make([]telemetry.Measurement, 0, 3)

	if r.Successes > 0 {
		var sum time.Duration
		for _, d := range r.RTTs {
			sum += d
		}
		out = append(out, telemetry.Valid("rtt", "ms", src, t, ms(sum/time.Duration(len(r.RTTs))), r.Successes, r.At))
	} else {
		out = append(out, telemetry.Unavailable("rtt", "ms", src, t, "no probe completed", r.Attempts, r.At))
	}

	if len(r.RTTs) >= 2 {
		var acc time.Duration
		for i := 1; i < len(r.RTTs); i++ {
			d := r.RTTs[i] - r.RTTs[i-1]
			if d < 0 {
				d = -d
			}
			acc += d
		}
		out = append(out, telemetry.Valid("jitter", "ms", src, t, ms(acc/time.Duration(len(r.RTTs)-1)), len(r.RTTs), r.At))
	} else {
		out = append(out, telemetry.Unavailable("jitter", "ms", src, t, "needs at least 2 successful samples", len(r.RTTs), r.At))
	}

	if r.Attempts >= MinLossSamples {
		loss := math.Round(float64(r.Attempts-r.Successes)/float64(r.Attempts)*1000) / 10
		out = append(out, telemetry.Valid("packet_loss", "percent", src, t, loss, r.Attempts, r.At))
	} else {
		out = append(out, telemetry.Unavailable("packet_loss", "percent", src, t, "too few samples for a loss estimate", r.Attempts, r.At))
	}
	return out
}
