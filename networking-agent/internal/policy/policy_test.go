package policy

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestAllowlist(t *testing.T) {
	cases := []struct {
		name       string
		typ        string
		params     string
		privileged bool
		ok         bool
	}{
		{"cp test", "connectivity_test", `{"target":"control_plane","count":5}`, false, true},
		{"peer test", "connectivity_test", `{"target":"peer","peerDeviceId":"0123456789abcdef01234567","count":3}`, false, true},
		{"peer without id", "connectivity_test", `{"target":"peer","count":3}`, false, false},
		{"count too high", "connectivity_test", `{"target":"control_plane","count":500}`, false, false},
		{"unknown field", "connectivity_test", `{"target":"control_plane","count":1,"cmd":"rm -rf /"}`, false, false},
		{"transfer", "transfer_test", `{"peerDeviceId":"0123456789abcdef01234567","megabytes":8}`, false, true},
		{"transfer too big", "transfer_test", `{"peerDeviceId":"0123456789abcdef01234567","megabytes":500}`, false, false},
		{"transfer no peer", "transfer_test", `{"megabytes":8}`, false, false},
		{"transfer extra field", "transfer_test", `{"peerDeviceId":"0123456789abcdef01234567","megabytes":8,"target":"8.8.8.8"}`, false, false},
		{"report", "report_peer_status", `{}`, false, true},
		{"refresh in safe mode", "refresh_vpn_config", `{}`, false, false},
		{"refresh privileged", "refresh_vpn_config", `{}`, true, true},
		{"shell", "exec", `{"cmd":"id"}`, true, false},
	}
	for _, c := range cases {
		_, err := Check(c.typ, json.RawMessage(c.params), c.privileged)
		if (err == nil) != c.ok {
			t.Errorf("%s: err=%v, want ok=%v", c.name, err, c.ok)
		}
	}
	if _, err := Check("exec", nil, true); !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("unknown command must wrap ErrUnknownCommand, got %v", err)
	}
}
