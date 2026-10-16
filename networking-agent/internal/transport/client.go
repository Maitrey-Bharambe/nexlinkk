// Package transport implements the signed HTTP protocol between the agent
// and the control plane. It carries control traffic only — never VPN data.
package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 1 << 20

// Signer signs canonical request strings with the agent's identity key.
type Signer interface {
	Sign(msg []byte) string
}

// CanonicalRequest must match control-plane/src/middleware/agentAuth.js byte for byte.
func CanonicalRequest(method, path string, timestampMs int64, nonce, deviceID string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{
		"NEXLINK-AGENT-SIG-V1",
		strings.ToUpper(method),
		path,
		strconv.FormatInt(timestampMs, 10),
		nonce,
		deviceID,
		hex.EncodeToString(sum[:]),
	}, "\n")
}

// APIError is a structured error from the control plane envelope.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type Client struct {
	BaseURL  string
	DeviceID string
	Signer   Signer
	HTTP     *http.Client
	Now      func() time.Time
}

func New(baseURL string, signer Signer, deviceID string) *Client {
	return &Client{
		BaseURL:  strings.TrimRight(baseURL, "/"),
		DeviceID: deviceID,
		Signer:   signer,
		HTTP:     &http.Client{Timeout: 15 * time.Second},
		Now:      time.Now,
	}
}

func newNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Do sends a signed request. path includes any query string, e.g. "/api/v1/agent/commands".
func (c *Client) Do(ctx context.Context, method, path string, in, out any) error {
	return c.send(ctx, method, path, in, out, true)
}

// DoUnsigned is used only for enrollment, before an identity is registered.
func (c *Client) DoUnsigned(ctx context.Context, method, path string, in, out any) error {
	return c.send(ctx, method, path, in, out, false)
}

func (c *Client) send(ctx context.Context, method, path string, in, out any, signed bool) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", "nexlink-agent")
	if signed {
		ts := c.Now().UnixMilli()
		nonce := newNonce()
		sig := c.Signer.Sign([]byte(CanonicalRequest(method, path, ts, nonce, c.DeviceID, body)))
		req.Header.Set("X-NexLink-Device", c.DeviceID)
		req.Header.Set("X-NexLink-Timestamp", strconv.FormatInt(ts, 10))
		req.Header.Set("X-NexLink-Nonce", nonce)
		req.Header.Set("X-NexLink-Signature", sig)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return &APIError{Status: resp.StatusCode, Code: "BAD_RESPONSE", Message: "non-JSON response"}
	}
	if !env.OK || resp.StatusCode >= 400 {
		e := &APIError{Status: resp.StatusCode, Code: "UNKNOWN", Message: "request failed"}
		if env.Error != nil {
			e.Code, e.Message = env.Error.Code, env.Error.Message
		}
		return e
	}
	if out != nil && len(env.Data) > 0 {
		return json.Unmarshal(env.Data, out)
	}
	return nil
}
