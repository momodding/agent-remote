# agenticRemote

## Quickstart

```sh
make backend-build
backend/bin/agenticRemote config init --path examples/config.local.json
backend/bin/agenticRemote serve --config examples/config.local.json
```

`serve` starts the HTTPS/WSS daemon, prints a terminal QR immediately, and rolls the QR every 45 seconds. Start the Expo client, then scan that daemon QR in the app or paste the printed raw JSON pairing payload if camera access is unavailable.

Expo client:

```sh
cd client
npm ci
npx expo start
```

Open Expo Go and scan the Metro QR to launch the managed app. In the app, enter this device's name, then scan the daemon QR or paste its raw pairing payload.

Or from the repository root:

```sh
make run-client
```
