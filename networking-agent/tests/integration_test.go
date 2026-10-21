//go:build integration

// Integration test: real agent code against a running control plane.
// Category: agent ↔ control plane over HTTP on one machine. It does NOT touch
// WireGuard or host networking (the interface is inspected read-only and is
// expected to be absent/unavailable on a dev box).
//
//	NEXLINK_IT_SERVER=http://127.0.0.1:3000 NEXLINK_IT_TOKEN=nxe_... go test -tags integration ./tests/
package tests

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/nexlink/networking-agent/internal/agent"
	"github.com/nexlink/networking-agent/internal/config"
	"github.com/nexlink/networking-agent/internal/enrollment"
	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/transport"
	"github.com/nexlink/networking-agent/internal/wireguard"
)

func TestEnrollHeartbeatTelemetry(t *testing.T) {
	server, token := os.Getenv("NEXLINK_IT_SERVER"), os.Getenv("NEXLINK_IT_TOKEN")
	if server == "" || token == "" {
		t.Skip("set NEXLINK_IT_SERVER and NEXLINK_IT_TOKEN (a fresh enrollment token)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	id, err := identity.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	res, err := enrollment.Enroll(ctx, transport.New(server, id, ""), id, token, config.Version)
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	t.Logf("enrolled %s at %s", res.DeviceID, res.Address)

	// Replay of the same token must fail.
	id2, _ := identity.LoadOrCreate(t.TempDir())
	_, err = enrollment.Enroll(ctx, transport.New(server, id2, ""), id2, token, config.Version)
	var api *transport.APIError
	if !errors.As(err, &api) || api.Code != "ENROLLMENT_TOKEN_USED" {
		t.Fatalf("token replay: got %v", err)
	}

	cfg := config.Config{ServerURL: server, Interface: "nexlink-it-absent", HeartbeatInterval: 5 * time.Second, TelemetryInterval: 5 * time.Second, ProbePort: 22}
	a := agent.New(cfg, id, wireguard.NewInspector(), wireguard.NewApplier(false, id.WireGuardPrivateKey()), slog.Default())
	if err := a.SendTelemetry(ctx); err != nil {
		t.Fatalf("telemetry: %v", err)
	}
	runCtx, stop := context.WithTimeout(ctx, 7*time.Second)
	defer stop()
	if err := a.Run(runCtx); err != nil {
		t.Fatalf("run: %v", err)
	}
}
