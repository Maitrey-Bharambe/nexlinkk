package connectivity

import (
	"errors"
	"net"
	"strconv"
)

// StartResponder listens on the device's *tunnel* address only and closes
// every connection immediately. Peers probe it to measure RTT/loss across the
// tunnel; because it binds to the tunnel IP it is not reachable from the LAN,
// and it reads nothing from connections. It fails (and should be retried)
// while the tunnel interface does not exist yet.
func StartResponder(tunnelIP string, port int) (net.Listener, error) {
	ip := net.ParseIP(tunnelIP)
	if ip == nil || ip.To4() == nil {
		return nil, errors.New("responder: no tunnel IPv4 address")
	}
	ln, err := net.Listen("tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				if errors.Is(err, net.ErrClosed) {
					return
				}
				continue
			}
			c.Close()
		}
	}()
	return ln, nil
}
