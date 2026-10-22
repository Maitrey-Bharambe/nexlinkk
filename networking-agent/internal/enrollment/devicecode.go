package enrollment

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/nexlink/networking-agent/internal/identity"
	"github.com/nexlink/networking-agent/internal/transport"
)

// DeviceCodeMessage is the proof-of-possession string for "join with a code";
// must match web/server/modules/enrollment/deviceCode.service.js.
func DeviceCodeMessage(identityPub, wgPub, hostname string, ts int64) string {
	return strings.Join([]string{"NEXLINK-DEVICECODE-V1", identityPub, wgPub, hostname, strconv.FormatInt(ts, 10)}, "\n")
}

// Code is what the operator needs: the short code and where to enter it.
type Code struct {
	UserCode        string    `json:"userCode"`
	DeviceCode      string    `json:"deviceCode"`
	VerificationURL string    `json:"verificationUrl"`
	ExpiresAt       time.Time `json:"expiresAt"`
	IntervalSeconds int       `json:"intervalSeconds"`
}

type pollResult struct {
	Status     string  `json:"status"`
	Enrollment *Result `json:"enrollment"`
}

// ErrDenied and ErrExpired end a join attempt.
var (
	ErrDenied  = errors.New("an operator denied this computer's request to join")
	ErrExpired = errors.New("the code expired before anyone approved it — run the command again for a new code")
)

// Hostname is the name this computer suggests for itself.
func Hostname() string {
	h, err := os.Hostname()
	if err != nil || strings.TrimSpace(h) == "" {
		return "new-device"
	}
	if len(h) > 64 {
		h = h[:64]
	}
	return h
}

// RequestCode asks for a code, proving possession of this agent's keys.
func RequestCode(ctx context.Context, c *transport.Client, id *identity.Identity, agentVersion string) (*Code, error) {
	ts := time.Now().UnixMilli()
	host := Hostname()
	body := map[string]any{
		"identityPublicKey":  id.PublicKey(),
		"wireguardPublicKey": id.WireGuardPublicKey(),
		"hostname":           host,
		"agentVersion":       agentVersion,
		"platform":           runtime.GOOS,
		"timestamp":          ts,
		"signature":          id.Sign([]byte(DeviceCodeMessage(id.PublicKey(), id.WireGuardPublicKey(), host, ts))),
	}
	var code Code
	if err := c.DoUnsigned(ctx, "POST", "/api/v1/agent/device-code", body, &code); err != nil {
		return nil, err
	}
	if code.IntervalSeconds < 1 {
		code.IntervalSeconds = 3
	}
	return &code, nil
}

// WaitForApproval polls until an operator approves (state is then saved),
// denies, or the code expires.
func WaitForApproval(ctx context.Context, c *transport.Client, id *identity.Identity, code *Code) (*Result, error) {
	t := time.NewTicker(time.Duration(code.IntervalSeconds) * time.Second)
	defer t.Stop()
	for {
		var out pollResult
		err := c.DoUnsigned(ctx, "POST", "/api/v1/agent/device-code/poll", map[string]string{"deviceCode": code.DeviceCode}, &out)
		switch {
		case err != nil:
			// Transient network trouble: keep waiting until the code expires.
			if time.Now().After(code.ExpiresAt) {
				return nil, fmt.Errorf("%w (last error: %v)", ErrExpired, err)
			}
		case out.Status == "approved" && out.Enrollment != nil:
			res := out.Enrollment
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
			return res, nil
		case out.Status == "denied":
			return nil, ErrDenied
		case out.Status == "expired":
			return nil, ErrExpired
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-t.C:
		}
	}
}
