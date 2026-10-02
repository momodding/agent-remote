.PHONY: backend-test backend-build daemon-build daemon-release daemon-install daemon-remove client-test client-build client-build-web client-build-android client-build-ios test lint verify-phase1-4 verify-phase5-desktop verify-all run-daemon run-client run-client-web help

DAEMON_TARGETS ?= linux-amd64
CLIENT_TARGETS ?= web
DAEMON_TARGET ?=
CLIENT_TARGET ?=
GOFLAGS ?=
DAEMON_INSTALL_DIR ?= /usr/local/bin
DAEMON_CONFIG_DIR ?= /etc/agenticremote
RELEASE_TARGETS ?= linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DAEMON_BUILD_DIR ?= builds/daemon
DAEMON_RELEASE_DIR ?= builds/release
CLIENT_ANDROID_OUTPUT ?= builds/client-android.apk
CLIENT_ANDROID_SDK ?= $(HOME)/android-sdk
CLIENT_ANDROID_VARIANT ?= release
CLIENT_ANDROID_GRADLE_OPTS ?= -Dorg.gradle.jvmargs=-Xmx6144m -XX:MaxMetaspaceSize=1024m -XX:+UseG1GC -Dorg.gradle.parallel=true -Dorg.gradle.caching=true -Dorg.gradle.workers.max=8
DAEMON_BUILD_OUTPUT_DIR := $(abspath $(DAEMON_BUILD_DIR))
DAEMON_RELEASE_OUTPUT_DIR := $(abspath $(DAEMON_RELEASE_DIR))
CLIENT_ANDROID_OUTPUT_PATH := $(abspath $(CLIENT_ANDROID_OUTPUT))
CLIENT_ANDROID_SDK_PATH := $(abspath $(CLIENT_ANDROID_SDK))

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
	@set -eu; \
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
		mkdir -p "$(DAEMON_BUILD_OUTPUT_DIR)/$$target"; \
		( cd backend && GOOS=$$goos GOARCH=$$goarch CGO_ENABLED=0 go build $(GOFLAGS) -ldflags "-X main.version=$(VERSION) -X main.commit=$(COMMIT)" -o "$(DAEMON_BUILD_OUTPUT_DIR)/$$target/agenticRemote$$exe" ./cmd/agenticRemote ); \
	done

daemon-release:
	@set -eu; \
	rm -rf "$(DAEMON_RELEASE_OUTPUT_DIR)"; \
	mkdir -p "$(DAEMON_RELEASE_OUTPUT_DIR)"; \
	$(MAKE) daemon-build DAEMON_TARGETS="$(RELEASE_TARGETS)" DAEMON_BUILD_DIR="$(DAEMON_BUILD_DIR)"; \
	cd "$(DAEMON_RELEASE_OUTPUT_DIR)"; \
	for target in $(RELEASE_TARGETS); do \
		goos=$${target%%-*}; \
		goarch=$${target#*-}; \
		exe=; \
		if [ "$$goos" = windows ]; then exe=.exe; fi; \
		archive="agenticRemote_$(VERSION)_$${goos}_$${goarch}.tar.gz"; \
		tar -czf "$$archive" -C "$(DAEMON_BUILD_OUTPUT_DIR)/$$target" "agenticRemote$$exe"; \
	done; \
	sha256sum agenticRemote_*.tar.gz > SHA256SUMS; \
	echo "release artifacts written to $(DAEMON_RELEASE_DIR) (version $(VERSION), commit $(COMMIT))"

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
	@set -eu; \
	for target in $(CLIENT_BUILD_TARGETS); do \
		case "$$target" in \
			web) ( cd client && bun install && bun run build:web ) ;; \
			android) \
				sdk_dir=$(call shq,$(CLIENT_ANDROID_SDK_PATH)); \
				if [ ! -d "$$sdk_dir" ]; then echo "android SDK not found at $$sdk_dir; set CLIENT_ANDROID_SDK to an installed Android SDK" >&2; exit 1; fi; \
				mkdir -p "$(dir $(CLIENT_ANDROID_OUTPUT_PATH))"; \
				( cd client && bun install ); \
				if [ ! -f client/android/gradlew ]; then ( cd client && CI=1 bunx expo prebuild --platform android --no-install ); fi; \
				if [ ! -f client/android/local.properties ]; then printf 'sdk.dir=%s\n' "$$sdk_dir" > client/android/local.properties; fi; \
				variant=$(call shq,$(CLIENT_ANDROID_VARIANT)); \
				variant_cap=$$(printf '%s' "$$variant" | awk '{print toupper(substr($$0,1,1)) substr($$0,2)}'); \
				assemble_task="assemble$$variant_cap"; \
				lint_exclude=""; \
				if [ "$$variant" = release ]; then lint_exclude="-x lintVital$$variant_cap"; fi; \
				( cd client/android && ANDROID_HOME="$$sdk_dir" ANDROID_SDK_ROOT="$$sdk_dir" GRADLE_OPTS=$(call shq,$(CLIENT_ANDROID_GRADLE_OPTS)) ./gradlew "$$assemble_task" --console=plain $$lint_exclude ); \
				apk_src="client/android/app/build/outputs/apk/$$variant/app-$$variant.apk"; \
				if [ ! -f "$$apk_src" ]; then echo "gradle reported success but no APK at $$apk_src" >&2; exit 1; fi; \
				cp "$$apk_src" "$(CLIENT_ANDROID_OUTPUT_PATH)"; \
				echo "$(CLIENT_ANDROID_OUTPUT_PATH)" ;; \
			ios) \
				if [ "$$(uname -s)" != Darwin ]; then echo "client-build ios requires macOS" >&2; exit 1; fi; \
				if ! command -v npm >/dev/null 2>&1; then echo "eas-cli local builds require npm on PATH; install Node.js with npm and retry" >&2; exit 1; fi; \
				( cd client && bun install && EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 bunx eas-cli build --platform ios --local ) ;; \
			*) echo "unsupported client target: $$target" >&2; exit 1 ;; \
		esac; \
	done

client-build-web:
	$(MAKE) client-build CLIENT_TARGETS=web

client-build-android:
	$(MAKE) client-build CLIENT_TARGETS=android

client-build-ios:
	$(MAKE) client-build CLIENT_TARGETS=ios

test:
	$(MAKE) backend-test
	$(MAKE) client-test

verify-phase1-4:
	@echo "===== Preflight Environment ====="
	@echo "Git SHA: $$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
	@echo "OS:      $$(uname -s 2>/dev/null || echo 'unknown')"
	@echo "Go:      $$(go version 2>/dev/null || echo 'not found')"
	@echo "Bun:     $$(bun --version 2>/dev/null || echo 'not found')"
	@echo "OMP:     $$(omp --version 2>/dev/null || echo 'not found')"
	@echo "tmux:    $$(tmux -V 2>/dev/null || echo 'not found')"
	@echo "================================="
	@echo "Building backend..."
	cd backend && go build ./...
	@echo "Running vet..."
	cd backend && go vet ./...
	@echo "Running hermetic Golden Flow tests (strict integration)..."
	cd backend && AGENTICREMOTE_STRICT_INTEGRATION=1 go test -v -count=1 ./internal/agent/... -run 'TestGoldenFlowHermetic.*' -timeout 600s
	cd backend && AGENTICREMOTE_STRICT_INTEGRATION=1 go test -v -count=1 ./internal/agent/... -run TestHermeticOMP -timeout 180s
	@echo "Running full backend test suite..."
	cd backend && go test -count=1 -timeout 600s ./...
	@echo "Running race detector on concurrency-sensitive packages..."
	cd backend && go test -race -count=1 -timeout 600s ./internal/agent/... ./internal/session/...
	@echo "Running client typecheck..."
	cd client && bun install && bun run typecheck
	@echo "Running client test suite..."
	cd client && bun run test
	@echo "===== verify-phase1-4 PASSED ====="

lint:
	cd backend && go vet ./...
	cd client && bun install && bun run typecheck

verify-phase5-desktop:
	@echo "===== Preflight Environment (Phase 5 Desktop) ====="
	@echo "Git SHA: $$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
	@echo "OS:      $$(uname -s 2>/dev/null || echo 'unknown')"
	@echo "Go:      $$(go version 2>/dev/null || echo 'not found')"
	@echo "Xvfb:    $$(which Xvfb 2>/dev/null || echo 'not found')"
	@echo "x11vnc:  $$(x11vnc -version 2>&1 | head -n 1 2>/dev/null || echo 'not found')"
	@echo "==================================================="
	@echo "Running Phase 5 Desktop Golden Flow test (strict integration)..."
	cd backend && AGENTICREMOTE_STRICT_INTEGRATION=1 go test -v -count=1 ./internal/server -run '^TestGoldenFlowPhase5Desktop$$' -timeout 180s
	@echo "===== verify-phase5-desktop PASSED ====="
verify-all: verify-phase1-4 verify-phase5-desktop
run-daemon:
	cd backend && go run ./cmd/agenticRemote serve --config ../examples/config.local.json

run-client:
	cd client && bun start

run-client-web:
	cd client && BROWSER=none bun run web

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
	echo '  client-build-android  build a signed release APK via Gradle (CLIENT_ANDROID_SDK/CLIENT_ANDROID_OUTPUT)'; \
	echo '  test                  run backend and client tests'; \
	echo '  lint                  run backend vet and client typecheck'; \
	echo '  run-daemon            run daemon using examples/config.local.json'; \
	echo '  run-client            start Expo client'; \
	echo '  run-client-web        start Expo client with the web target'