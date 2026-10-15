//go:build e2e

package server

import "os"

func e2eRFBUnavailableTarget() bool {
	return os.Getenv("AGENTICREMOTE_E2E_DESKTOP_TARGET") != ""
}

func e2eRFBTarget() string {
	return os.Getenv("AGENTICREMOTE_E2E_DESKTOP_TARGET")
}
