// Package enrollment performs the one-time device enrollment handshake.
package enrollment

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/transport"
)

type request struct {
	EnrollmentToken    string `json:"enrollmentToken"`
	IdentityPublicKey  string `json:"identityPublicKey"`
	WireguardPublicKey string `json:"wireguardPublicKey"`
	AgentVersion       string `json:"agentVersion"`
	Platform           string `json:"platform"`
	Timestamp          int64  `json:"timestamp"`
	Signature          string `json:"signature"`
}

type Result struct {
	DeviceID                 string `json:"deviceId"`
	DeviceName               string `json:"deviceName"`
	IdentityFingerprint      string `json:"identityFingerprint"`
	Address                  string `json:"address"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	Network                  struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		CIDR string `json:"cidr"`
	} `json:"network"`
}

// Message is the proof-of-possession string; must match
// control-plane/src/modules/enrollment/enrollment.service.js.
func Message(token, identityPub, wgPub string, ts int64) string {
	sum := sha256.Sum256([]byte(token))
	return strings.Join([]string{"NEXLINK-ENROLL-V1", hex.EncodeToString(sum[:]), identityPub, wgPub, strconv.FormatInt(ts, 10)}, "\n")
}

// Enroll exchanges a one-time token for a device identity. The token itself
// is never logged or persisted.
func Enroll(ctx context.Context, c *transport.Client, id *identity.Identity, token, agentVersion string) (*Result, error) {
	ts := time.Now().UnixMilli()
	body := request{
		EnrollmentToken:    strings.TrimSpace(token),
		IdentityPublicKey:  id.PublicKey(),
		WireguardPublicKey: id.WireGuardPublicKey(),
		AgentVersion:       agentVersion,
		Platform:           runtime.GOOS,
		Timestamp:          ts,
	}
	body.Signature = id.Sign([]byte(Message(body.EnrollmentToken, body.IdentityPublicKey, body.WireguardPublicKey, ts)))
	var res Result
	if err := c.DoUnsigned(ctx, "POST", "/api/v1/agent/enroll", body, &res); err != nil {
		return nil, err
	}
	id.State = identity.State{
		DeviceID:            res.DeviceID,
		DeviceName:          res.DeviceName,
		ServerURL:           c.BaseURL,
		NetworkID:           res.Network.ID,
		NetworkCIDR:         res.Network.CIDR,
		Address:             res.Address,
		IdentityFingerprint: res.IdentityFingerprint,
		EnrolledAt:          time.Now().UTC(),
	}
	if err := id.SaveState(); err != nil {
		return nil, err
	}
	return &res, nil
}
