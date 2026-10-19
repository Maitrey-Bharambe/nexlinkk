package agent

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/nexlink/networking-agent/internal/telemetry"
)

// Event is one agent log line shipped to the control plane so the console
// can show what the agent is doing (the "agent console" on the device page).
type Event struct {
	At      string         `json:"at"`
	Level   string         `json:"level"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields"`
}

const (
	maxEventFields  = 12
	maxEventMessage = 300
	maxFieldString  = 200
)

var secretKey = regexp.MustCompile(`(?i)token|secret|password|private|signature|key$`)

// EventBuffer keeps the most recent log events until they are uploaded.
type EventBuffer struct {
	mu     sync.Mutex
	events []Event
	max    int
}

func NewEventBuffer(max int) *EventBuffer { return &EventBuffer{max: max} }

func (b *EventBuffer) add(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, e)
	if over := len(b.events) - b.max; over > 0 {
		b.events = b.events[over:] // drop oldest
	}
}

// Take removes and returns up to n of the oldest buffered events.
func (b *EventBuffer) Take(n int) []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n > len(b.events) {
		n = len(b.events)
	}
	out := append([]Event(nil), b.events[:n]...)
	b.events = b.events[n:]
	return out
}

// Requeue puts events back at the front after a failed upload.
func (b *EventBuffer) Requeue(evs []Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(append([]Event(nil), evs...), b.events...)
	if over := len(b.events) - b.max; over > 0 {
		b.events = b.events[over:]
	}
}

func (b *EventBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.events)
}

// teeHandler forwards records to the normal log handler and also records
// Info-and-above events (with secret-looking fields redacted) for upload.
type teeHandler struct {
	next  slog.Handler
	buf   *EventBuffer
	attrs []slog.Attr
}

// NewEventLogger wraps a handler so Info+ log lines are also captured in buf.
func NewEventLogger(next slog.Handler, buf *EventBuffer) *slog.Logger {
	return slog.New(&teeHandler{next: next, buf: buf})
}

func (h *teeHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelInfo || h.next.Enabled(ctx, l)
}

func (h *teeHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelInfo {
		fields := map[string]any{}
		add := func(a slog.Attr) bool {
			if len(fields) < maxEventFields {
				fields[a.Key] = fieldValue(a)
			}
			return true
		}
		for _, a := range h.attrs {
			add(a)
		}
		r.Attrs(add)
		msg := r.Message
		if len(msg) > maxEventMessage {
			msg = msg[:maxEventMessage]
		}
		h.buf.add(Event{At: telemetry.Ts(r.Time), Level: levelName(r.Level), Message: msg, Fields: fields})
	}
	if h.next.Enabled(ctx, r.Level) {
		return h.next.Handle(ctx, r)
	}
	return nil
}

func (h *teeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &teeHandler{next: h.next.WithAttrs(attrs), buf: h.buf, attrs: append(append([]slog.Attr(nil), h.attrs...), attrs...)}
}

func (h *teeHandler) WithGroup(name string) slog.Handler {
	return &teeHandler{next: h.next.WithGroup(name), buf: h.buf, attrs: h.attrs}
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	default:
		return "debug"
	}
}

func fieldValue(a slog.Attr) any {
	if secretKey.MatchString(a.Key) {
		return "[redacted]"
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindBool:
		return v.Bool()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		return v.Float64()
	case slog.KindDuration:
		return v.Duration().Round(time.Millisecond).String()
	case slog.KindTime:
		return telemetry.Ts(v.Time())
	default:
		s := fmt.Sprint(v.Any())
		if len(s) > maxFieldString {
			s = s[:maxFieldString]
		}
		return s
	}
}
