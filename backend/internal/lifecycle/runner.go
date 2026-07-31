package lifecycle

import (
	"context"
	"os/exec"
)

// DefaultRunnerProvider uses os/exec.CommandContext.
type DefaultRunnerProvider struct{}

// Command creates a command runner.
func (p *DefaultRunnerProvider) Command(ctx context.Context, name string, args ...string) Runner {
	return &defaultRunner{cmd: exec.CommandContext(ctx, name, args...)}
}

type defaultRunner struct {
	cmd *exec.Cmd
}

func (r *defaultRunner) Output() ([]byte, error) {
	return r.cmd.Output()
}

func (r *defaultRunner) CombinedOutput() ([]byte, error) {
	return r.cmd.CombinedOutput()
}
