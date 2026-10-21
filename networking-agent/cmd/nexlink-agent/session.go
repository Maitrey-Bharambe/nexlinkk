package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/nexlink/networking-agent/internal/session"
)

// cmdSession opens a remote session to another device of the network through
// the running agent's tunnel:
//
//	nexlink-agent session --list
//	nexlink-agent session pc-2 rdp          # Remote Desktop (mstsc on Windows)
//	nexlink-agent session pc-2 ssh --user me
//	nexlink-agent session 10.10.0.3 http     # opens the browser
func cmdSession(args []string) error {
	fs := flag.NewFlagSet("session", flag.ExitOnError)
	stateDir := fs.String("state-dir", "", "state directory of the running agent (default: the agent this user started last)")
	user := fs.String("user", "", "ssh: user name on the remote device")
	list := fs.Bool("list", false, "list devices and what they share")
	noLaunch := fs.Bool("no-launch", false, "only open the tunnel port and print it; do not start a client")
	// Flags may come before or after the positional arguments.
	var pos []string
	for {
		_ = fs.Parse(args)
		if fs.NArg() == 0 {
			break
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}

	path := session.DefaultInfoPath()
	if *stateDir != "" {
		path = session.InfoPathIn(*stateDir)
	}
	info, err := session.LoadInfo(path)
	if err != nil {
		return err
	}

	if *list || len(pos) == 0 {
		var peers []session.Peer
		if err := session.Call(info, "GET", "/v1/peers", nil, &peers); err != nil {
			return err
		}
		if len(peers) == 0 {
			fmt.Println("no other devices in your network yet")
			return nil
		}
		fmt.Printf("%-24s %-15s %-14s %s\n", "DEVICE", "TUNNEL IP", "STATUS", "SHARES")
		for _, p := range peers {
			st := "offline"
			if p.Online {
				st = "online/" + p.Path
			}
			shares := make([]string, 0, len(p.Services))
			for _, s := range p.Services {
				shares = append(shares, s.Name+":"+strconv.Itoa(s.Port))
			}
			if len(shares) == 0 {
				shares = append(shares, "-")
			}
			fmt.Printf("%-24s %-15s %-14s %s\n", p.Name, p.IP, st, strings.Join(shares, " "))
		}
		if len(pos) == 0 {
			fmt.Println("\nopen one with: nexlink-agent session <device> [rdp|ssh|vnc|http|...]")
		}
		return nil
	}

	req := session.ForwardRequest{Peer: pos[0]}
	if len(pos) > 1 {
		req.Service = pos[1]
	}
	var out session.ForwardResponse
	if err := session.Call(info, "POST", "/v1/forward", req, &out); err != nil {
		return err
	}
	local := "127.0.0.1:" + strconv.Itoa(out.LocalPort)
	state := "offline (the first connection waits for its tunnel)"
	if out.Peer.Online {
		state = "online via " + out.Peer.Path
	}
	fmt.Printf("%s %s → %s  (%s, %s)\n", out.Peer.Name, out.Service, local, out.Peer.IP, state)
	if *noLaunch {
		return nil
	}
	switch out.Service {
	case "rdp":
		if runtime.GOOS == "windows" {
			fmt.Println("starting Remote Desktop…")
			return exec.Command("mstsc", "/v:"+local).Start()
		}
		fmt.Printf("connect your RDP client to %s (e.g. xfreerdp /v:%s)\n", local, local)
	case "ssh":
		target := "127.0.0.1"
		if *user != "" {
			target = *user + "@" + target
		}
		sshArgs := []string{"-p", strconv.Itoa(out.LocalPort), "-o", "HostKeyAlias=nexlink-" + out.Peer.Name, target}
		if _, err := exec.LookPath("ssh"); err != nil {
			fmt.Printf("ssh %s\n", strings.Join(sshArgs, " "))
			return nil
		}
		c := exec.Command("ssh", sshArgs...)
		c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
		return c.Run()
	case "http", "https":
		url := out.Service + "://" + local
		fmt.Println("opening", url)
		return openBrowser(url)
	default:
		fmt.Printf("point your %s client at %s\n", out.Service, local)
	}
	return nil
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
