.PHONY: backend-test backend-build daemon-build daemon-install daemon-remove client-test client-build client-build-web client-build-android client-build-ios test lint run-daemon run-client help

DAEMON_TARGETS ?= linux-amd64
CLIENT_TARGETS ?= web
DAEMON_TARGET ?=
CLIENT_TARGET ?=
GOFLAGS ?=
DAEMON_INSTALL_DIR ?= /usr/local/bin
DAEMON_CONFIG_DIR ?= /etc/agenticremote

DAEMON_BUILD_TARGETS := $(strip $(if $(DAEMON_TARGET),$(DAEMON_TARGET),$(DAEMON_TARGETS)))
CLIENT_BUILD_TARGETS := $(strip $(if $(CLIENT_TARGET),$(CLIENT_TARGET),$(CLIENT_TARGETS)))

# Host-native target for daemon-install; never settable from the command line.
override DAEMON_HOST_TARGET := $(shell go env GOHOSTOS)-$(shell go env GOHOSTARCH)

# Shell-quote a Make value as a single, safe shell token (handles spaces and metacharacters).
shq = '$(subst ','"'"',$(1))'

backend-test:
	cd backend && go test ./...

backend-build:
	$(MAKE) daemon-build

daemon-build:
	for target in $(DAEMON_BUILD_TARGETS); do \
		case "$$target" in \
			linux) target=linux-amd64 ;; \
			macos) target=darwin-arm64 ;; \
			macos-amd64) target=darwin-amd64 ;; \
			macos-arm64) target=darwin-arm64 ;; \
			windows) target=windows-amd64 ;; \
			raspberrypi|androidbox) target=linux-arm64 ;; \
			linux-amd64|linux-arm64|darwin-amd64|darwin-arm64|windows-amd64) ;; \
			*) echo "unsupported daemon target: $$target" >&2; exit 1 ;; \
		esac; \
		goos=$${target%%-*}; \
		goarch=$${target#*-}; \
		exe=; \
		if [ "$$goos" = windows ]; then exe=.exe; fi; \
		mkdir -p builds/daemon/$$target; \
		cd backend && GOOS=$$goos GOARCH=$$goarch CGO_ENABLED=0 go build $(GOFLAGS) -o ../builds/daemon/$$target/agenticRemote$$exe ./cmd/agenticRemote && cd ..; \
	done

daemon-install:
	@set -eu; \
	host=$(call shq,$(DAEMON_HOST_TARGET)); \
	case "$$host" in \
		linux-amd64|linux-arm64|darwin-amd64|darwin-arm64) ;; \
		*) echo "unsupported host target: $$host" >&2; exit 1 ;; \
	esac; \
	install_dir=$(call shq,$(DAEMON_INSTALL_DIR)); \
	config_dir=$(call shq,$(DAEMON_CONFIG_DIR)); \
	check_path() { \
		p="$$1"; label="$$2"; min="$$3"; \
		case "$$p" in \
			/*) : ;; \
			*) echo "$$label must be an absolute path: $$p" >&2; exit 1 ;; \
		esac; \
		case "$$p" in \
			/) echo "$$label must not be /: $$p" >&2; exit 1 ;; \
			*/) echo "$$label must not end in /: $$p" >&2; exit 1 ;; \
			*//*) echo "$$label must not contain //: $$p" >&2; exit 1 ;; \
		esac; \
		( IFS=/; n=0; \
			for seg in $$p; do \
				case "$$seg" in \
					"") ;; \
					.|..) echo "$$label must not contain a . or .. path segment: $$p" >&2; exit 1 ;; \
					*) n=$$((n + 1)) ;; \
				esac; \
			done; \
			if [ "$$n" -lt "$$min" ]; then \
				echo "$$label must have at least $$min path segment(s) below root: $$p" >&2; exit 1; \
			fi \
		) || exit 1; \
	}; \
	check_path "$$install_dir" "DAEMON_INSTALL_DIR" 1; \
	check_path "$$config_dir" "DAEMON_CONFIG_DIR" 2; \
	marker="$$config_dir/.agenticremote-managed-by-make"; \
	if [ -e "$$config_dir" ] && [ ! -f "$$marker" ]; then \
		echo "refusing to install: $$config_dir exists and is not Make-managed (missing $$marker)" >&2; \
		exit 1; \
	fi; \
	$(MAKE) daemon-build DAEMON_TARGET="$$host"; \
	install -d -m 0755 "$$install_dir" "$$config_dir"; \
	install -m 0755 "builds/daemon/$$host/agenticRemote" "$$install_dir/agenticRemote"; \
	[ -f "$$marker" ] || install -m 0644 /dev/null "$$marker"; \
	bin="$$install_dir/agenticRemote"; \
	echo "installed daemon binary: $$bin"; \
	echo "managed config directory: $$config_dir"; \
	echo; \
	echo "next steps:"; \
	printf '  sudo '\''%s'\'' config init --path '\''%s'\''\n' "$$bin" "$$config_dir"; \
	printf '  sudo '\''%s'\'' serve --config '\''%s/config.json'\''\n' "$$bin" "$$config_dir"; \
	printf '  '\''%s'\'' version\n' "$$bin"

daemon-remove:
	@set -eu; \
	install_dir=$(call shq,$(DAEMON_INSTALL_DIR)); \
	config_dir=$(call shq,$(DAEMON_CONFIG_DIR)); \
	check_path() { \
		p="$$1"; label="$$2"; min="$$3"; \
		case "$$p" in \
			/*) : ;; \
			*) echo "$$label must be an absolute path: $$p" >&2; exit 1 ;; \
		esac; \
		case "$$p" in \
			/) echo "$$label must not be /: $$p" >&2; exit 1 ;; \
			*/) echo "$$label must not end in /: $$p" >&2; exit 1 ;; \
			*//*) echo "$$label must not contain //: $$p" >&2; exit 1 ;; \
		esac; \
		( IFS=/; n=0; \
			for seg in $$p; do \
				case "$$seg" in \
					"") ;; \
					.|..) echo "$$label must not contain a . or .. path segment: $$p" >&2; exit 1 ;; \
					*) n=$$((n + 1)) ;; \
				esac; \
			done; \
			if [ "$$n" -lt "$$min" ]; then \
				echo "$$label must have at least $$min path segment(s) below root: $$p" >&2; exit 1; \
			fi \
		) || exit 1; \
	}; \
	check_path "$$install_dir" "DAEMON_INSTALL_DIR" 1; \
	check_path "$$config_dir" "DAEMON_CONFIG_DIR" 2; \
	marker="$$config_dir/.agenticremote-managed-by-make"; \
	if [ -e "$$config_dir" ] && [ ! -f "$$marker" ]; then \
		echo "refusing to remove: $$config_dir exists and is not Make-managed (missing $$marker)" >&2; \
		exit 1; \
	fi; \
	rm -f "$$install_dir/agenticRemote"; \
	rm -rf "$$config_dir"; \
	echo "removed: $$install_dir/agenticRemote"; \
	echo "removed: $$config_dir"

client-test:
	cd client && bun install && bun run typecheck && bun run test

client-build:
	for target in $(CLIENT_BUILD_TARGETS); do \
		case "$$target" in \
			web) cd client && bun install && bun run build:web && cd .. ;; \
			android) if [ ! -d "$$ANDROID_HOME" ] && [ ! -d "$$ANDROID_SDK_ROOT" ]; then echo "ANDROID_HOME (or ANDROID_SDK_ROOT) must point to an installed Android SDK directory; export one of them before running client-build-android" >&2; exit 1; fi; mkdir -p builds && cd client && bun install && EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 bunx eas-cli build --platform android --profile preview --local --non-interactive --output ../builds/client-android.apk && cd .. ;; \
			ios) cd client && bun install && EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 bunx eas-cli build --platform ios --local && cd .. ;; \
			*) echo "unsupported client target: $$target" >&2; exit 1 ;; \
		esac; \
	done

client-build-web:
	$(MAKE) client-build CLIENT_TARGETS=web

client-build-android:
	$(MAKE) client-build CLIENT_TARGETS=android ANDROID_HOME=$$HOME/android-sdk ANDROID_SDK_ROOT=$$HOME/android-sdk

client-build-ios:
	$(MAKE) client-build CLIENT_TARGETS=ios

test:
	$(MAKE) backend-test
	$(MAKE) client-test

lint:
	cd backend && go vet ./...
	cd client && bun install && bun run typecheck

run-daemon:
	cd backend && go run ./cmd/agenticRemote serve --config ../examples/config.local.json

run-client:
	cd client && bun start

help:
	@echo 'Targets:'; \
	echo '  backend-test          run backend Go tests'; \
	echo '  backend-build         alias for daemon-build'; \
	echo '  daemon-build          cross-compile the daemon binary (DAEMON_TARGETS/DAEMON_TARGET)'; \
	echo '  daemon-install        build for this host and install system-wide (DAEMON_INSTALL_DIR/DAEMON_CONFIG_DIR)'; \
	echo '  daemon-remove         remove the Make-managed daemon binary and its config/state tree'; \
	echo '  client-test           install client deps, typecheck, and run client tests'; \
	echo '  client-build          build the client for CLIENT_TARGETS/CLIENT_TARGET'; \
	echo '  client-build-web      alias for client-build CLIENT_TARGETS=web'; \
	echo '  client-build-android  alias for client-build CLIENT_TARGETS=android'; \
	echo '  client-build-ios      alias for client-build CLIENT_TARGETS=ios'; \
	echo '  test                  run backend-test and client-test'; \
	echo '  lint                  run go vet and client typecheck'; \
	echo '  run-daemon            run the daemon locally against examples/config.local.json'; \
	echo '  run-client            run the Expo client dev server'; \
	echo '  help                  show this message'; \
	echo; \
	echo 'Overrides:'; \
	echo '  DAEMON_TARGETS="linux-amd64 darwin-arm64"  space-separated daemon-build cross-compile list'; \
	echo '  DAEMON_TARGET=linux-arm64                  single daemon-build target, overrides DAEMON_TARGETS'; \
	echo '  CLIENT_TARGETS="web android"                space-separated client-build target list'; \
	echo '  CLIENT_TARGET=ios                           single client-build target, overrides CLIENT_TARGETS'; \
	echo '  GOFLAGS=-trimpath                           extra flags passed to go build'; \
	echo '  DAEMON_INSTALL_DIR=/usr/local/bin            daemon-install/daemon-remove binary directory'; \
	echo '  DAEMON_CONFIG_DIR=/etc/agenticremote          daemon-install/daemon-remove managed config directory'; \
	echo; \
	echo 'daemon-install always builds host-native (current OS/arch); cross targets stay in daemon-build.'; \
	echo; \
	echo 'Standard system-wide install:'; \
	echo '  sudo make daemon-install'; \
	echo '  sudo make daemon-remove'
