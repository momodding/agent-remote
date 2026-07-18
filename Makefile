.PHONY: backend-test backend-build daemon-build client-test client-build client-build-web test lint run-daemon run-client

DAEMON_TARGETS ?= linux-amd64
CLIENT_TARGETS ?= web
DAEMON_TARGET ?=
CLIENT_TARGET ?=
GOFLAGS ?=
FLUTTER_BUILD_FLAGS ?=

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
	cd client && flutter test

client-build:
	for target in $(CLIENT_BUILD_TARGETS); do \
		case "$$target" in \
			web) \
				rm -rf builds/client/web; \
				cd client && flutter build web $(FLUTTER_BUILD_FLAGS) --output ../builds/client/web && cd .. \
				;; \
			android) \
				cd client && flutter build apk $(FLUTTER_BUILD_FLAGS) && cd ..; \
				rm -rf builds/client/android; \
				mkdir -p builds/client/android; \
				cp client/build/app/outputs/flutter-apk/*.apk builds/client/android/ \
				;; \
			android-arm64) \
				cd client && flutter build apk --target-platform android-arm64 $(FLUTTER_BUILD_FLAGS) && cd ..; \
				rm -rf builds/client/android-arm64; \
				mkdir -p builds/client/android-arm64; \
				cp client/build/app/outputs/flutter-apk/*.apk builds/client/android-arm64/ \
				;; \
			windows) \
				cd client && flutter build windows $(FLUTTER_BUILD_FLAGS) && cd ..; \
				rm -rf builds/client/windows; \
				cp -R client/build/windows/x64/runner/Release builds/client/windows \
				;; \
			macos) \
				cd client && flutter build macos $(FLUTTER_BUILD_FLAGS) && cd ..; \
				rm -rf builds/client/macos; \
				mkdir -p builds/client/macos; \
				cp -R client/build/macos/Build/Products/Release/agentic_remote.app builds/client/macos/agentic_remote.app \
				;; \
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
	cd client && dart analyze

run-daemon:
	cd backend && go run ./cmd/agenticRemote serve --config ../examples/config.local.json

run-client:
	cd client && flutter run -d chrome
