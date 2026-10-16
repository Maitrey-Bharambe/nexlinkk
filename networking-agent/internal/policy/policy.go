// Package policy is the agent-side allowlist for remote commands.
//
// The control plane already validates and requires human approval for every
// action. The agent checks again: it runs only command types it knows, with
// parameters it validates, and refuses privileged ones unless privileged
// mode was enabled locally by the machine's operator. A compromised control
// plane therefore still cannot make the agent run arbitrary operations.
package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

type ConnectivityParams struct {
	Target       string `json:"target"`
	PeerDeviceID string `json:"peerDeviceId,omitempty"`
	Count        int    `json:"count"`
}

type Spec struct {
	Privileged bool
	validate   func(json.RawMessage) (any, error)
}

var objectID = regexp.MustCompile(`^[a-f0-9]{24}$`)

func strictDecode(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

var commands = map[string]Spec{
	"connectivity_test": {validate: func(raw json.RawMessage) (any, error) {
		var p ConnectivityParams
		if err := strictDecode(raw, &p); err != nil {
			return nil, err
		}
		if p.Target != "control_plane" && p.Target != "peer" {
			return nil, errors.New("target must be control_plane or peer")
		}
		if p.Target == "peer" && !objectID.MatchString(p.PeerDeviceID) {
			return nil, errors.New("peerDeviceId required for peer target")
		}
		if p.Count < 1 || p.Count > 20 {
			return nil, errors.New("count must be 1..20")
		}
		return p, nil
	}},
	"report_peer_status": {validate: func(raw json.RawMessage) (any, error) {
		var p struct{}
		return p, strictDecode(raw, &p)
	}},
	"refresh_vpn_config": {Privileged: true, validate: func(raw json.RawMessage) (any, error) {
		var p struct{}
		return p, strictDecode(raw, &p)
	}},
}

// ErrUnknownCommand is returned for any type outside the allowlist.
var ErrUnknownCommand = errors.New("command type not in agent allowlist")

// Check validates a command and returns its parsed parameters.
func Check(cmdType string, params json.RawMessage, privilegedEnabled bool) (any, error) {
	spec, ok := commands[cmdType]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownCommand, cmdType)
	}
	if spec.Privileged && !privilegedEnabled {
		return nil, errors.New("privileged command refused: privileged mode is disabled on this host")
	}
	p, err := spec.validate(params)
	if err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	return p, nil
}
