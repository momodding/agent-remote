package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/notify"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/server"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	qrcode "github.com/skip2/go-qrcode"
)

const version = "agenticRemote dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: agenticRemote <serve|config|version>")
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
		cfg := config.Default()
		if err := os.MkdirAll(filepath.Dir(*path), 0o755); err != nil {
			return err
		}
		return config.WriteSample(*path, cfg)
	case "version":
		fmt.Println(version)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func serve(configPath string) error {
	configPath, err := filepath.Abs(configPath)
	if err != nil {
		return err
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	configDir := filepath.Dir(configPath)
	stateDir := filepath.Join(configDir, cfg.StateDir)
	workspaceRoot := filepath.Join(configDir, cfg.WorkspaceRoot)
	tlsMaterial, err := security.EnsureTLS(stateDir, cfg.ListenAddr)
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
	auth.SetPairedHook(func() {
		select {
		case qrRefresh <- struct{}{}:
		default:
		}
	})
	manager, err := session.NewManager(stateDir, workspaceRoot, cfg.MaxScrollbackBytes, cfg.ChannelBufferSize, &notify.Fanout{Log: &notify.LogNotifier{}, Expo: &notify.ExpoNotifier{Endpoint: cfg.ExpoPushEndpoint, Client: http.DefaultClient, Tokens: tokens}})
	if err != nil {
		return err
	}
	cfg.StateDir = stateDir
	cfg.WorkspaceRoot = workspaceRoot
	srv, err := server.New(cfg, tlsMaterial, auth, manager, tokens)
	if err != nil {
		return err
	}
	go rotatePairing(pairings, cfg, tlsMaterial.Fingerprint, qrRefresh)
	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: srv.Handler(), TLSConfig: srv.TLSConfig()}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	if os.Getenv("AGENTICREMOTE_TEST_ONESHOT") == "1" || cfg.ListenAddr == "127.0.0.1:0" {
		go func() {
			<-time.After(200 * time.Millisecond)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = httpServer.Shutdown(ctx)
		}()
	}
	if err := httpServer.ServeTLS(listener, tlsMaterial.CertPath, tlsMaterial.KeyPath); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	if os.Getenv("AGENTICREMOTE_TEST_ONESHOT") == "1" || cfg.ListenAddr == "127.0.0.1:0" {
		return errors.New("daemon exited")
	}
	return nil
}

func rotatePairing(store *security.PairingStore, cfg config.Config, fingerprint string, refresh <-chan struct{}) {
	for {
		now := time.Now().UTC()
		if err := store.Cleanup(now); err != nil {
			log.Printf("pairing cleanup failed: %v", err)
		}
		payload, err := store.Create(cfg.PublicEndpoint, fingerprint, now)
		if err != nil {
			log.Printf("pairing create failed: %v", err)
		} else {
			printPairing(payload)
		}
		select {
		case <-time.After(45 * time.Second):
		case <-refresh:
		}
	}
}

func printPairing(payload *security.PairingPayload) {
	data, err := qrcode.New(string(mustJSON(payload)), qrcode.Medium)
	if err != nil {
		log.Printf("pairing qr failed: %v", err)
		return
	}
	fmt.Println(data.ToSmallString(false))
	fmt.Println(string(mustJSON(payload)))
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
