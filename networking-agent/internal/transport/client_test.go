package transport

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

type seedSigner struct{ key ed25519.PrivateKey }

func (s seedSigner) Sign(m []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, m))
}

func testSeed() []byte {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	return seed
}

// Cross-language vector produced by the control plane's Node implementation
// (control-plane/src/middleware/agentAuth.js). If this fails, the Go agent and
// the server disagree on the canonical request format.
func TestCanonicalRequestMatchesControlPlaneVector(t *testing.T) {
	const (
		wantPub = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ="
		wantMsg = "NEXLINK-AGENT-SIG-V1\nPOST\n/api/v1/agent/heartbeat\n1700000000000\nAAAAAAAAAAAAAAAAAAAAAA\n0123456789abcdef01234567\n0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72"
		wantSig = "9f8OGv8ZpjwAuPZXkYjYihuCUrMyDNKpWJAL3sC755F/uCKWWQRVWtIAKJ2Cfj/RNijLEwojP2Gc2SVQmtZZDg=="
	)
	key := ed25519.NewKeyFromSeed(testSeed())
	if got := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)); got != wantPub {
		t.Fatalf("public key = %s, want %s", got, wantPub)
	}
	msg := CanonicalRequest("POST", "/api/v1/agent/heartbeat", 1700000000000, "AAAAAAAAAAAAAAAAAAAAAA", "0123456789abcdef01234567", []byte(`{"schemaVersion":1}`))
	if msg != wantMsg {
		t.Fatalf("canonical string mismatch:\n%q\n%q", msg, wantMsg)
	}
	if sig := (seedSigner{key}).Sign([]byte(msg)); sig != wantSig {
		t.Fatalf("signature mismatch: %s", sig)
	}
}

func TestSignedRequestIsVerifiableByServer(t *testing.T) {
	key := ed25519.NewKeyFromSeed(testSeed())
	pub := key.Public().(ed25519.PublicKey)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		ts, _ := strconv.ParseInt(r.Header.Get("X-NexLink-Timestamp"), 10, 64)
		msg := CanonicalRequest(r.Method, r.URL.RequestURI(), ts, r.Header.Get("X-NexLink-Nonce"), r.Header.Get("X-NexLink-Device"), body)
		sig, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-NexLink-Signature"))
		if !ed25519.Verify(pub, []byte(msg), sig) {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": map[string]string{"code": "AGENT_SIGNATURE_INVALID", "message": "bad"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": map[string]int{"pendingCommands": 2}})
	}))
	defer srv.Close()

	c := New(srv.URL, seedSigner{key}, "0123456789abcdef01234567")
	var out struct{ PendingCommands int }
	if err := c.Do(context.Background(), "POST", "/api/v1/agent/heartbeat", map[string]int{"sequence": 1}, &out); err != nil {
		t.Fatal(err)
	}
	if out.PendingCommands != 2 {
		t.Fatalf("decoded %+v", out)
	}

	// Wrong key → server rejects; error surfaces as structured APIError.
	other := ed25519.NewKeyFromSeed(make([]byte, 32))
	bad := New(srv.URL, seedSigner{other}, "0123456789abcdef01234567")
	err := bad.Do(context.Background(), "GET", "/api/v1/agent/commands", nil, nil)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "AGENT_SIGNATURE_INVALID" {
		t.Fatalf("expected APIError, got %v", err)
	}
}

func TestNonceIsUniqueAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		n := newNonce()
		if len(n) < 16 || len(n) > 64 || seen[n] {
			t.Fatalf("bad nonce %q", n)
		}
		seen[n] = true
	}
	_ = time.Now
}
