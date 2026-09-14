package session

import (
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"

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
	tty    string
	closed bool
}

func newPtyBackend(cmd *exec.Cmd, cols, rows int) (*PtyBackend, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, err
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		_ = tty.Close()
		_ = ptmx.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
	cmd.SysProcAttr.Setctty = true
	if err := cmd.Start(); err != nil {
		_ = tty.Close()
		_ = ptmx.Close()
		return nil, err
	}
	ttyName := tty.Name()
	if err := tty.Close(); err != nil {
		_ = ptmx.Close()
		return nil, err
	}
	return &PtyBackend{cmd: cmd, ptmx: ptmx, tty: ttyName}, nil
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
	if b.closed {
		return ""
	}
	return b.tty
}
