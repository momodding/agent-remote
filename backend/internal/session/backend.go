package session

import (
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/creack/pty"
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
	mu     sync.RWMutex
	cmd    *exec.Cmd
	ptmx   *os.File
	closed bool
}

func newPtyBackend(cmd *exec.Cmd, cols, rows int) (*PtyBackend, error) {
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, err
	}
	return &PtyBackend{cmd: cmd, ptmx: ptmx}, nil
}

func (b *PtyBackend) file() (*os.File, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed || b.ptmx == nil {
		return nil, os.ErrClosed
	}
	return b.ptmx, nil
}

func (b *PtyBackend) Read(data []byte) (int, error) {
	file, err := b.file()
	if err != nil {
		return 0, err
	}
	return file.Read(data)
}

func (b *PtyBackend) Write(data []byte) (int, error) {
	file, err := b.file()
	if err != nil {
		return 0, err
	}
	return file.Write(data)
}

func (b *PtyBackend) Resize(cols, rows int) error {
	file, err := b.file()
	if err != nil {
		return err
	}
	return pty.Setsize(file, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (b *PtyBackend) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	file := b.ptmx
	b.ptmx = nil
	b.mu.Unlock()
	if b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
	}
	if file == nil {
		return nil
	}
	return file.Close()
}

func (b *PtyBackend) Alive() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return !b.closed && b.ptmx != nil
}
func (b *PtyBackend) Identity() string {
	if b.cmd.Process == nil {
		return ""
	}
	return strconv.Itoa(b.cmd.Process.Pid)
}

func (b *PtyBackend) TTY() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed || b.cmd.Process == nil {
		return ""
	}
	tty, err := os.Readlink("/proc/" + strconv.Itoa(b.cmd.Process.Pid) + "/fd/0")
	if err != nil {
		return ""
	}
	return tty
}
