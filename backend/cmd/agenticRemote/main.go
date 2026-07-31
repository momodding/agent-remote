package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/lifecycle"
	"github.com/agenticremote/agenticremote/backend/internal/notify"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/server"
	"github.com/agenticremote/agenticremote/backend/internal/session"
)

const sniffDeadline = 5 * time.Second

// version and commit are stamped by release builds with -ldflags.
var (
	version = "dev"
	commit  = ""
)

type stringList []string

func (v *stringList) String() string { return fmt.Sprint([]string(*v)) }

func (v *stringList) Set(value string) error {
	*v = append(*v, value)
	return nil
}

type sniffListener struct {
	net.Listener
	tlsConfig *tls.Config
}

type prependConn struct {
	net.Conn
	buf  byte
	done bool
}

func (c *prependConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if !c.done {
		c.done = true
		p[0] = c.buf
		if len(p) == 1 {
			return 1, nil
		}
		n, err := c.Conn.Read(p[1:])
		return n + 1, err
	}
	return c.Conn.Read(p)
}

func (l *sniffListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if err := conn.SetReadDeadline(time.Now().Add(sniffDeadline)); err != nil {
		_ = conn.Close()
		return nil, &tempError{err: err}
	}
	var buf [1]byte
	if _, err := io.ReadFull(conn, buf[:]); err != nil {
		_ = conn.Close()
		return nil, &tempError{err: err}
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		_ = conn.Close()
		return nil, &tempError{err: err}
	}
	wrapped := &prependConn{Conn: conn, buf: buf[0]}
	if buf[0] == 0x16 && l.tlsConfig != nil {
		return tls.Server(wrapped, l.tlsConfig), nil
	}
	return wrapped, nil
}

type tempError struct{ err error }

func (e *tempError) Error() string { return e.err.Error() }

func (e *tempError) Temporary() bool { return true }

func (e *tempError) Timeout() bool {
	var netErr net.Error
	if errors.As(e.err, &netErr) {
		return netErr.Timeout()
	}
	return false
}

func (e *tempError) Unwrap() error { return e.err }

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: agenticRemote <serve|pair|config|install|uninstall|update|version>")
	}

	switch args[0] {
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		configPath := fs.String("config", "", "config path")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *configPath == "" {
			return errors.New("serve requires --config")
		}
		return serve(*configPath)
	case "pair":
		return errors.New("pairing starts with serve; run agenticRemote serve --config <path>")
	case "config":
		if len(args) < 2 || args[1] != "init" {
			return errors.New("usage: agenticRemote config init --path <path>")
		}
		fs := flag.NewFlagSet("config init", flag.ContinueOnError)
		path := fs.String("path", "", "output path")
		if err := fs.Parse(args[2:]); err != nil {
			return err
		}
		if *path == "" {
			return errors.New("config init requires --path")
		}
		configPath := *path
		if info, err := os.Stat(configPath); err == nil && info.IsDir() {
			configPath = filepath.Join(configPath, "config.json")
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err := os.Stat(configPath); err == nil {
			if err := config.CleanState(configPath); err != nil {
				return fmt.Errorf("cleaning state: %w", err)
			}
			fmt.Fprintln(os.Stderr, "existing config found; TLS certificates, pairings, auth sessions, and PTY sessions removed")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		cfg := config.Default()
		if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
			return err
		}
		return config.WriteSample(configPath, cfg)
	case "install":
		return installCommand(args[1:])
	case "uninstall":
		return uninstallCommand(args[1:])
	case "update":
		return updateCommand(args[1:])
	case "version":
		if commit == "" {
			fmt.Println(version)
		} else {
			fmt.Printf("%s (%s)\n", version, commit)
		}
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func lifecycleService() (*lifecycle.Service, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("cannot resolve daemon home: %w", err)
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve absolute daemon home: %w", err)
	}
	return lifecycle.NewService(filepath.Clean(home), nil), nil
}

func installCommand(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	listen := fs.String("listen", "", "listen address")
	publicEndpoint := fs.String("public-endpoint", "", "public endpoint URL")
	workspaceRoot := fs.String("workspace-root", "", "workspace root")
	stateDir := fs.String("state-dir", "", "state directory relative to $HOME/.remote")
	var allowedCIDRs stringList
	fs.Var(&allowedCIDRs, "allowed-cidr", "allowed source CIDR (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	svc, err := lifecycleService()
	if err != nil {
		return err
	}
	err = svc.Install(context.Background(), lifecycle.InstallOptions{Config: lifecycle.Config{
		Listen: *listen, PublicEndpoint: *publicEndpoint, AllowedCIDRs: allowedCIDRs,
		WorkspaceRoot: *workspaceRoot, StateDir: *stateDir,
	}})
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "installed to $HOME/.remote; LAN access remains loopback-only unless --listen, --public-endpoint, and --allowed-cidr are explicitly supplied")
	fmt.Fprintln(os.Stdout, "for boot before login, ask an administrator to run: loginctl enable-linger $USER")
	return nil
}

func uninstallCommand(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	purge := fs.Bool("purge", false, "remove managed config and state as well")
	if err := fs.Parse(args); err != nil {
		return err
	}
	svc, err := lifecycleService()
	if err != nil {
		return err
	}
	if err := svc.Uninstall(context.Background(), lifecycle.UninstallOptions{Purge: *purge}); err != nil {
		return err
	}
	if *purge {
		fmt.Fprintln(os.Stdout, "removed managed installation, configuration, and state from $HOME/.remote")
	} else {
		fmt.Fprintln(os.Stdout, "removed managed binary and unit; configuration and state remain in $HOME/.remote")
	}
	return nil
}

func updateCommand(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	targetVersion := fs.String("version", "stable", "release version or stable")
	force := fs.Bool("force", false, "allow replacing a same or newer installed version")
	baseURL := fs.String("base-url", "", "release download base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	svc, err := lifecycleService()
	if err != nil {
		return err
	}
	if err := svc.Update(context.Background(), lifecycle.UpdateOptions{Version: *targetVersion, Force: *force, BaseURL: *baseURL}); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "updated managed daemon")
	return nil
}

func serve(configPath string) error {
	configPath, err := filepath.Abs(configPath)
	if err != nil {
		return err
	}
	daemonHome, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("cannot resolve daemon home: %w", err)
	}
	daemonHome = filepath.Clean(daemonHome)
	if stat, err := os.Stat(daemonHome); err != nil || !stat.IsDir() {
		return fmt.Errorf("daemon home is not a valid directory: %s", daemonHome)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	configDir := filepath.Dir(configPath)
	stateDir := filepath.Join(configDir, cfg.StateDir)
	workspaceRoot := filepath.Join(configDir, cfg.WorkspaceRoot)
	tlsMaterial, err := security.EnsureTLS(stateDir, cfg.ListenAddr, cfg.PublicEndpoint)
	if err != nil {
		return err
	}
	pairings, err := security.LoadPairingStore(stateDir)
	if err != nil {
		return err
	}
	sessions, err := security.LoadSessionStore(stateDir)
	if err != nil {
		return err
	}
	tokens, err := notify.LoadTokenStore(stateDir)
	if err != nil {
		return err
	}
	auth := security.NewAuthService(pairings, sessions)
	qrRefresh := make(chan struct{}, 1)
	pairingReady := make(chan struct{}, 1)
	auth.SetPairedHook(func() {
		select {
		case qrRefresh <- struct{}{}:
		default:
		}
	})
	manager, err := session.NewManager(daemonHome, stateDir, workspaceRoot, cfg.MaxScrollbackBytes, cfg.ChannelBufferSize, &notify.Fanout{Log: &notify.LogNotifier{}, Expo: &notify.ExpoNotifier{Endpoint: cfg.ExpoPushEndpoint, Client: http.DefaultClient, Tokens: tokens}})
	if err != nil {
		return err
	}
	cfg.StateDir = stateDir
	cfg.WorkspaceRoot = workspaceRoot
	pairingSnapshot := &security.PairingSnapshot{}
	srv, err := server.New(cfg, tlsMaterial, auth, manager, tokens, pairingSnapshot)
	if err != nil {
		return err
	}
	go rotatePairing(context.Background(), pairings, pairingSnapshot, cfg, tlsMaterial.Fingerprint, qrRefresh, pairingReady)
	httpServer := server.ServerTimeouts(srv.Handler(), cfg.ListenAddr)
	tlsConfig := srv.TLSConfig()
	tlsConfig.NextProtos = []string{"h2", "http/1.1"}
	httpServer.TLSConfig = tlsConfig
	rawListener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	listener := &sniffListener{Listener: rawListener, tlsConfig: tlsConfig}
	log.Printf("serving on %s (accepting HTTP and HTTPS)", listener.Addr())
	if os.Getenv("AGENTICREMOTE_TEST_ONESHOT") == "1" || cfg.ListenAddr == "127.0.0.1:0" {
		go func() {
			select {
			case <-pairingReady:
			case <-time.After(time.Second):
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = httpServer.Shutdown(ctx)
		}()
	}
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	if os.Getenv("AGENTICREMOTE_TEST_ONESHOT") == "1" || cfg.ListenAddr == "127.0.0.1:0" {
		return errors.New("daemon exited")
	}
	return nil
}

func rotatePairing(ctx context.Context, store *security.PairingStore, snapshot *security.PairingSnapshot, cfg config.Config, fingerprint string, refresh <-chan struct{}, ready chan<- struct{}) {
	for {
		now := time.Now().UTC()
		if err := store.Cleanup(now); err != nil {
			log.Printf("pairing cleanup failed: %v", err)
		}
		lifetime := time.Duration(cfg.PairingRotationSeconds)*time.Second + 5*time.Second
		payload, err := store.Create(cfg.PublicEndpoint, fingerprint, cfg.SkipFingerprintVerification, lifetime, now)
		if err != nil {
			log.Printf("pairing create failed: %v", err)
		} else {
			// Build canonical presentation from payload
			presentation, err := security.BuildPresentation(payload)
			if err != nil {
				log.Printf("pairing presentation build failed: %v", err)
			} else {
				snapshot.Store(presentation)
				printPresentation(presentation)
				if ready != nil {
					select {
					case ready <- struct{}{}:
					default:
					}
					ready = nil
				}
			}
		}

		timer := time.NewTimer(time.Duration(cfg.PairingRotationSeconds) * time.Second)
		select {
		case <-timer.C:
		case <-refresh:
			if !timer.Stop() {
				<-timer.C
			}
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		}
	}
}

func printPresentation(presentation *security.PairingPresentation) {
	fmt.Println(presentation.QRTerminal)
	fmt.Println(string(presentation.CanonicalJSON))
}
