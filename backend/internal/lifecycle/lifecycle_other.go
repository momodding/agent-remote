//go:build !darwin
// +build !darwin

package lifecycle

import (
	"context"
	"errors"
)

func (s *Service) installDarwin(context.Context, InstallOptions) error {
	return errors.New("install: unsupported platform")
}

func (s *Service) uninstallDarwin(context.Context, UninstallOptions) error {
	return errors.New("uninstall: unsupported platform")
}

func (s *Service) restartDarwin(context.Context) error {
	return errors.New("restart: unsupported platform")
}
