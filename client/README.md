# agenticRemote Expo client

This is a managed Expo app. Install Expo Go on the phone before connecting.

## Run

```sh
npm ci
npx expo start
```

Open Expo Go and scan the Metro QR to open the app. In the app, enter a device name, then scan the daemon pairing QR or paste its raw JSON payload.

## Commands

```sh
npm run typecheck
npm test
npm run build:web
npm start
```

For direct LAN or self-signed daemon endpoints, the pairing payload must set `skipFingerprintVerification: true`; Expo Go cannot dynamically trust or pin the daemon certificate. Public endpoints need a browser-trusted TLS certificate. See `../docs/android-daemon-connect.md` for setup details.
