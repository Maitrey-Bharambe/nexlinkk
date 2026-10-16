// Package identity owns the agent's long-lived keys and enrollment state.
//
// Two keys are generated locally and never leave the device:
//   - an Ed25519 signing key: the agent's identity towards the control plane
//   - a WireGuard (Curve25519) private key: the tunnel identity
//
// Only the public halves are sent during enrollment.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

const (
	signingKeyFile   = "identity.key"
	wireguardKeyFile = "wireguard.key"
	stateFile        = "state.json"
)

// State is the non-secret enrollment result persisted between runs.
type State struct {
	DeviceID            string    `json:"deviceId"`
	DeviceName          string    `json:"deviceName"`
	ServerURL           string    `json:"serverUrl"`
	NetworkID           string    `json:"networkId"`
	NetworkCIDR         string    `json:"networkCidr"`
	Address             string    `json:"address"`
	IdentityFingerprint string    `json:"identityFingerprint"`
	EnrolledAt          time.Time `json:"enrolledAt"`
}

type Identity struct {
	dir          string
	signingKey   ed25519.PrivateKey
	wireguardKey wgtypes.Key
	State        State
}

// LoadOrCreate loads keys from dir, generating any that are missing.
// Key files are written with 0600 permissions (on Windows, protect the
// directory with NTFS ACLs; see README).
func LoadOrCreate(dir string) (*Identity, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	id := &Identity{dir: dir}

	seed, err := readOrCreate(filepath.Join(dir, signingKeyFile), func() ([]byte, error) {
		s := make([]byte, ed25519.SeedSize)
		_, err := rand.Read(s)
		return s, err
	})
	if err != nil {
		return nil, fmt.Errorf("signing key: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, errors.New("signing key file is corrupt")
	}
	id.signingKey = ed25519.NewKeyFromSeed(seed)

	wg, err := readOrCreate(filepath.Join(dir, wireguardKeyFile), func() ([]byte, error) {
		k, err := wgtypes.GeneratePrivateKey()
		return k[:], err
	})
	if err != nil {
		return nil, fmt.Errorf("wireguard key: %w", err)
	}
	if id.wireguardKey, err = wgtypes.NewKey(wg); err != nil {
		return nil, fmt.Errorf("wireguard key file is corrupt: %w", err)
	}

	if b, err := os.ReadFile(filepath.Join(dir, stateFile)); err == nil {
		if err := json.Unmarshal(b, &id.State); err != nil {
			return nil, fmt.Errorf("state file is corrupt: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return id, nil
}

// readOrCreate reads a base64 key file or creates it with gen().
func readOrCreate(path string, gen func() ([]byte, error)) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		return base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	raw, err := gen()
	if err != nil {
		return nil, err
	}
	enc := base64.StdEncoding.EncodeToString(raw) + "\n"
	// O_EXCL: never silently overwrite an existing key.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.WriteString(enc); err != nil {
		return nil, err
	}
	return raw, nil
}

// PublicKey returns the Ed25519 identity public key, standard base64.
func (i *Identity) PublicKey() string {
	return base64.StdEncoding.EncodeToString(i.signingKey.Public().(ed25519.PublicKey))
}

// WireGuardPublicKey returns the tunnel public key, standard base64.
func (i *Identity) WireGuardPublicKey() string { return i.wireguardKey.PublicKey().String() }

// WireGuardPrivateKey is used only by the privileged applier to configure the interface.
func (i *Identity) WireGuardPrivateKey() wgtypes.Key { return i.wireguardKey }

// Sign returns a base64 Ed25519 signature over msg.
func (i *Identity) Sign(msg []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(i.signingKey, msg))
}

func (i *Identity) Enrolled() bool { return i.State.DeviceID != "" }

// SaveState persists the (non-secret) enrollment state atomically.
func (i *Identity) SaveState() error {
	b, err := json.MarshalIndent(i.State, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(i.dir, stateFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(i.dir, stateFile))
}

// FromSeed builds an in-memory identity (tests only).
func FromSeed(seed []byte, wg wgtypes.Key) *Identity {
	return &Identity{signingKey: ed25519.NewKeyFromSeed(seed), wireguardKey: wg}
}
