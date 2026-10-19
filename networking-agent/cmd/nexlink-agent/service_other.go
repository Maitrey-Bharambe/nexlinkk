//go:build !windows

package main

import "errors"

var errNotWindows = errors.New("background service install is Windows-only; on Linux/macOS run `nexlink-agent run` under systemd or launchd")

func isWindowsService() bool    { return false }
func cmdInstall([]string) error { return errNotWindows }
func cmdUninstall() error       { return errNotWindows }
func cmdServiceStatus() error   { return errNotWindows }
func runService([]string) error { return errNotWindows }
