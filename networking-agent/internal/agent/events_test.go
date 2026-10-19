package agent

import (
	"context"
	"log/slog"
	"strings"
	"testing"
)

func TestEventLoggerCapturesInfoAndRedactsSecrets(t *testing.T) {
	buf := NewEventBuffer(3)
	var out strings.Builder
	log := NewEventLogger(slog.NewTextHandler(&out, &slog.HandlerOptions{Level: slog.LevelWarn}), buf).With("agent", "A")
	log.Debug("not captured")
	log.Info("telemetry sent", "peers", 2, "enrollment_token", "nxe_secret", "rtt_ms", 0.5)
	log.Warn("heartbeat failed", "err", "timeout")

	evs := buf.Take(10)
	if len(evs) != 2 {
		t.Fatalf("want 2 events (info+warn), got %d", len(evs))
	}
	e := evs[0]
	if e.Level != "info" || e.Message != "telemetry sent" || e.Fields["agent"] != "A" || e.Fields["peers"] != int64(2) {
		t.Fatalf("unexpected event %+v", e)
	}
	if e.Fields["enrollment_token"] != "[redacted]" {
		t.Fatal("secret-looking field must be redacted")
	}
	if strings.Contains(out.String(), "telemetry sent") || !strings.Contains(out.String(), "heartbeat failed") {
		t.Fatal("console output must still honour its own level")
	}
}

func TestEventBufferDropsOldestAndRequeues(t *testing.T) {
	b := NewEventBuffer(2)
	for _, m := range []string{"1", "2", "3"} {
		b.add(Event{Message: m})
	}
	got := b.Take(10)
	if len(got) != 2 || got[0].Message != "2" {
		t.Fatalf("oldest not dropped: %+v", got)
	}
	b.Requeue(got)
	if b.Len() != 2 || b.Take(1)[0].Message != "2" {
		t.Fatal("requeue must restore order")
	}
	_ = context.Background
}
