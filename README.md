# agenticRemote

## Quickstart

```sh
make backend-build
backend/bin/agenticRemote config init --path examples/config.local.json
backend/bin/agenticRemote serve --config examples/config.local.json
```

`serve` starts the HTTPS/WSS daemon, prints a terminal QR immediately, and rolls the QR every 45 seconds. Scan it in the Flutter client, enter this device's name there, or paste the printed raw JSON payload if camera access is unavailable.

Flutter client:

```sh
cd client && flutter pub get
flutter run -d chrome
```

Or from the repository root:

```sh
make run-client
```
