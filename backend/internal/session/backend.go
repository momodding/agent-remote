package session

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
	"strconv"
)

type TerminalBackend interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int) error
	Close() error
	Alive() bool
	Identity() string
}

type PtyBackend struct {
	cmd  *exec.Cmd
	ptmx *os.File
}

func newPtyBackend(cmd *exec.Cmd, cols, rows int) (*PtyBackend, error) {
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, err
	}
	return &PtyBackend{cmd: cmd, ptmx: ptmx}, nil
}

func (b *PtyBackend) Read(data []byte) (int, error)  { return b.ptmx.Read(data) }
func (b *PtyBackend) Write(data []byte) (int, error) { return b.ptmx.Write(data) }
func (b *PtyBackend) Resize(cols, rows int) error {
	return pty.Setsize(b.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}
func (b *PtyBackend) Close() error {
	if b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
	}
	return b.ptmx.Close()
}
func (b *PtyBackend) Alive() bool { return b.ptmx != nil }
func (b *PtyBackend) Identity() string {
	if b.cmd.Process == nil {
		return ""
	}
	return strconv.Itoa(b.cmd.Process.Pid)
}
