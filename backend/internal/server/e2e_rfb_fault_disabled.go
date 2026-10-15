//go:build !e2e

package server

func e2eRFBUnavailableTarget() bool { return false }

func e2eRFBTarget() string { return "" }
