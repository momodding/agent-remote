backend-test:
	cd backend && go test ./...

backend-build:
	cd backend && go build -o bin/agenticRemote ./cmd/agenticRemote

client-test:
	cd client && flutter test

client-build-web:
	cd client && flutter build web

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
