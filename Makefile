.PHONY: backend-test backend-build daemon-build client-test client-build client-build-web test lint run-daemon run-client

DAEMON_TARGETS ?= linux-amd64
CLIENT_TARGETS ?= web
DAEMON_TARGET ?=
CLIENT_TARGET ?=
GOFLAGS ?=

DAEMON_BUILD_TARGETS := $(strip $(if $(DAEMON_TARGET),$(DAEMON_TARGET),$(DAEMON_TARGETS)))
CLIENT_BUILD_TARGETS := $(strip $(if $(CLIENT_TARGET),$(CLIENT_TARGET),$(CLIENT_TARGETS)))

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

client-test:
	cd client && npm ci && npm run typecheck && npm test

client-build:
	for target in $(CLIENT_BUILD_TARGETS); do \
		case "$$target" in \
			web) cd client && npm ci && npm run build:web && cd .. ;; \
			*) echo "unsupported client target: $$target" >&2; exit 1 ;; \
		esac; \
	done

client-build-web:
	$(MAKE) client-build CLIENT_TARGETS=web

test:
	$(MAKE) backend-test
	$(MAKE) client-test

lint:
	cd backend && go vet ./...
	cd client && npm ci && npm run typecheck

run-daemon:
	cd backend && go run ./cmd/agenticRemote serve --config ../examples/config.local.json

run-client:
	cd client && npm start
