# Lifecycle Package Entry Points

## Exported Types

### Service
Main lifecycle manager wrapping install/uninstall/update operations.

```go
type Service struct {
    Home           string            // $HOME/.remote root
    RunnerProvider RunnerProvider    // command execution, testable
}
```

**Constructor:**
```go
func NewService(home string, provider RunnerProvider) *Service
```

### Config
Installation-time configuration options.

```go
type Config struct {
    Listen         string   // Listen address (e.g., "127.0.0.1:8765")
    PublicEndpoint string   // Public-facing endpoint
    AllowedCIDRs   []string // CIDR blocks to allow access
    WorkspaceRoot  string   // Daemon's workspace root
    StateDir       string   // State directory (e.g., "state")
}
```

### InstallOptions, UninstallOptions, UpdateOptions
Operation-specific parameters.

```go
type InstallOptions struct {
    Config Config
}

type UninstallOptions struct {
    Purge bool // Remove entire $HOME/.remote tree
}

type UpdateOptions struct {
    Version string // Target release tag; "stable" for latest
    Force   bool   // Allow downgrade/same-version
}
```

### Marker
Ownership/metadata file written by install; used to validate/track installation state.

```go
type Marker struct {
    SchemaVersion    int
    ManagedRoot      string  // Path to $HOME/.remote
    BinaryPath       string  // Path to installed binary
    ConfigPath       string  // Path to config file
    StatePath        string  // Path to state directory
    UnitPath         string  // Path to systemd unit
    InstalledVersion string  // Current installed version
    BinaryHash       string  // SHA-256 of binary (for drift detection)
    ConfigHash       string  // SHA-256 of config
    UnitHash         string  // SHA-256 of unit
}
```

### RunnerProvider, Runner
Interfaces for command execution. RunnerProvider is injectable for tests.

```go
type RunnerProvider interface {
    Command(ctx context.Context, name string, args ...string) Runner
}

type Runner interface {
    Output() ([]byte, error)
    CombinedOutput() ([]byte, error)
}
```

## Exported Methods

### Service.Install
Prepares the managed layout, binary, config, and systemd unit. Linux-only.

```go
func (s *Service) Install(ctx context.Context, opts InstallOptions) error
```

**Behavior:**
- Validates daemon home is a directory.
- Creates `$HOME/.remote/bin` and `$HOME/.remote/state`.
- Copies current executable to staged location, verifies it runs `version`.
- Atomically installs binary.
- Creates config.json with secure defaults (loopback-only listen/CIDRs).
- Writes ownership marker with metadata.
- Renders and writes systemd unit to XDG_CONFIG_HOME or $HOME/.config/systemd/user/.
- Runs `systemctl --user daemon-reload` and `systemctl --user enable --now agenticremote.service`.

**Error Cases:**
- Invalid home: returns "daemon home is not a valid directory"
- Binary verification fails: removes staged file, returns "verify binary failed"
- Unsupported platform (non-Linux): returns "unsupported platform (requires Linux with user systemd)"

### Service.Uninstall
Stops service and removes unit. Optionally removes entire managed root.

```go
func (s *Service) Uninstall(ctx context.Context, opts UninstallOptions) error
```

**Behavior:**
- Validates marker exists and is valid.
- Runs `systemctl --user disable --now agenticremote.service`.
- Removes the systemd unit file.
- Runs `systemctl --user daemon-reload`.
- If `Purge: true`, removes entire `$HOME/.remote` tree. Otherwise preserves config/state.

**Error Cases:**
- Invalid marker: returns "invalid marker"
- Unsupported platform: returns "unsupported platform (requires Linux with user systemd)"

### Service.Update
Placeholder for update logic (fetch, verify, stage, swap, health check, rollback).

```go
func (s *Service) Update(ctx context.Context, opts UpdateOptions) error
```

**Behavior (stub):**
- Validates marker exists.
- Currently returns nil (stub for later implementation).

## CLI Flags Required Later

These flags must be added to `backend/cmd/agenticRemote/main.go` for integration with the Service:

### install
```
agenticRemote install [--listen <addr>] [--public-endpoint <url>] [--allowed-cidr <cidr>]... [--workspace-root <path>] [--state-dir <dir>]
```

**Flags:**
- `--listen`: Listen address (default: 127.0.0.1:8765; omit to keep loopback-safe default)
- `--public-endpoint`: Public-facing endpoint (derived from listen by default)
- `--allowed-cidr`: Repeatable CIDR block (default: 127.0.0.0/8, ::1/128; omit to keep loopback-safe defaults)
- `--workspace-root`: Daemon's workspace root (default: $HOME)
- `--state-dir`: Relative state directory name (default: "state")

**Output:**
- Success: "Installed agenticremote binary to $HOME/.remote/bin/agenticRemote"
- Success: "Created config at $HOME/.remote/config.json"
- Success: "Created systemd unit at [path]"
- Success: "Enabled and started agenticremote.service"
- If loopback-only: "Using loopback-only defaults. To allow LAN access: install --listen 0.0.0.0:8765 --allowed-cidr 10.0.0.0/8"
- If user-manager not available: "User systemd not available. Admin may enable: loginctl enable-linger [user]"

### uninstall
```
agenticRemote uninstall [--purge]
```

**Flags:**
- `--purge`: Remove entire $HOME/.remote tree (default: false; preserves config/state)

**Output:**
- Success: "Stopped and removed agenticremote.service"
- Success: "Removed systemd unit at [path]"
- If not purged: "Preserved config and state in $HOME/.remote"
- If purged: "Removed entire managed installation from $HOME/.remote"

### update
```
agenticRemote update [--version <tag>] [--force]
```

**Flags:**
- `--version`: Target release tag (default: "stable"; fetch latest release metadata)
- `--force`: Allow downgrade or same version (default: false)

**Output:**
- Success: "Updated agenticremote to [version]"
- Success: "Service restarted"
- If health check fails: "Update failed health check, rolled back to [previous version]"
- If checksum mismatch: "Checksum verification failed (expected X, got Y)"
- If version not found: "Release [version] not found"

## Implementation Notes

**Scoped to `backend/internal/lifecycle`:**
- All path manipulation uses absolute paths after normalization.
- No ownership-sensitive symlink traversal.
- Atomic writes: stage → verify → rename.
- Marker validation blocks destructive operations when absent, malformed, or drifted.
- Service methods are Linux-only; non-Linux returns "unsupported platform" error immediately.
- All systemctl calls use `--user` (user-scoped systemd).

**Testing:**
- Service is fully testable via injected RunnerProvider.
- Tests cover: successful install, invalid home, binary verification failure, idempotent install, preserve/purge uninstall, invalid marker, config customization, systemd unit rendering, XDG path resolution, marker round-trip.
- No real systemd or GitHub calls in tests; all command execution is mocked.

**Stubs:**
- `Update` is a placeholder; real implementation deferred per plan.
- `generatePassword` is a stub; real implementation generates 16-char alphanumeric password.
- No checksum/hash computation in current phase; Marker fields exist for later use.
