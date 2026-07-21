<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/bun-migration -->

## Context

Migrate the Expo client’s package management and command execution from npm/npx to Bun, remove active npm-specific lockfile/configuration/instructions, and prove the client commands and unit tests run through Bun. Preserve the existing Expo/Jest behavior unless repository evidence shows Bun’s native test runner is a drop-in replacement; this is a tooling cutover, not an unrelated test-framework rewrite.

## Approach

1. **Cut over dependency locking and package metadata.** In `client/`, run `bun install` to generate `client/bun.lock`; commit it and delete `client/package-lock.json`. Add `"packageManager": "bun@1.3.14"` to `client/package.json` (insert after the `"private": true` line's sibling, i.e. anywhere in the top-level object — exact key/value: `"packageManager": "bun@1.3.14"`). Keep every existing script name and body unchanged: verified this session that `bun run typecheck` and `bun run test` already pass unmodified against the current `node_modules`, so `client/package.json`'s `scripts` block needs no rewrite. Do not add a `trustedDependencies` array: the only lockfile entry with `hasInstallScript: true` is `fsevents` (`optional: true`, `os: ["darwin"]`), and both `Makefile`/CI only ever run on Linux (`ubuntu-latest`), so its postinstall never needs to execute.
2. **Route every active command through Bun**, using `bun run <script>` for anything invoking a `package.json` script (matches `npm run <script>`), bare `bun <script-name>` only where the source used bare `npm <script-name>` (i.e. `npm start` → `bun start`, since Bun resolves a bare script name from `package.json` before falling back to a binary — verified `bun start` launches the `"start": "expo start"` script), `bun install` for `npm ci`, and `bun expo start` for `npx expo start` (verified `bun expo --version` runs the local `expo` binary directly, matching the Expo docs' own `bun expo install`/`bun expo prebuild` convention — do not use `bunx expo start`, mixing the two invocation styles in the same docs is inconsistent). Exact replacements, one per active occurrence:
   - `Makefile` line 39 (`client-test`): `cd client && npm ci && npm run typecheck && npm test` → `cd client && bun install && bun run typecheck && bun run test`.
   - `Makefile` line 44 (`client-build`, inside the `web)` case): `cd client && npm ci && npm run build:web && cd ..` → `cd client && bun install && bun run build:web && cd ..`.
   - `Makefile` line 58 (`lint`): `cd client && npm ci && npm run typecheck` → `cd client && bun install && bun run typecheck`.
   - `Makefile` line 64 (`run-client`): `cd client && npm start` → `cd client && bun start`.
   - `README.md` lines 17-18: `npm ci` / `npx expo start` → `bun install` / `bun expo start`.
   - `client/README.md` line 8: `npm ci` → `bun install`; line 9: `npx expo start` → `bun expo start`; lines 17-20: `npm run typecheck` / `npm test` / `npm run build:web` / `npm start` → `bun run typecheck` / `bun run test` / `bun run build:web` / `bun start`.
   - `docs/android-daemon-connect.md` lines 74-75 and 133-134 (two identical occurrences): `npm ci` / `npx expo start` → `bun install` / `bun expo start`.
3. **Replace the CI Node/npm toolchain with Bun.** In `.github/workflows/ci.yml`, rename the `node:` job key to `client:` (Node/npm is no longer the toolchain the job name should imply). Replace the `actions/setup-node@v4` step (lines 28-32, including its `with: node-version: 22`, `cache: npm`, `cache-dependency-path: client/package-lock.json`) with `uses: oven-sh/setup-bun@v2` and `with: bun-version: 1.3.14` — no separate cache configuration is needed (`setup-bun` caches the Bun binary itself; `bun install`'s own local cache is unaffected by this action). Replace the four run steps (lines 33-36) with `bun install`, `bun run typecheck`, `bun run test`, `bun run build:web`.
4. **Delete obsolete npm artifacts.** Delete `client/package-lock.json` (superseded by `client/bun.lock` from step 1). No other npm lockfile, `.npmrc`, or root `package.json` exists in the tree. After steps 1-3, grep active files (everything except `plans/**`, which documents an already-completed prior migration and is not live instructions) for `npm ci|npm run|npm test|npm start|npx |package-lock\.json|setup-node`; every remaining hit must be fixed by one of steps 1-3 or is a stale finding to correct before verification.

## Critical files & anchors

- `client/package.json` — `scripts`, dependencies, and new `packageManager` declaration define every Bun command.
- `Makefile` — `client-test`, `client-build`, `lint`, and `run-client` are the repository’s public command surface.
- `.github/workflows/ci.yml` — current `node` job is npm- and `package-lock.json`-specific.
- `client/jest.config.js` — kept unchanged; `bun run test` runs `jest --runInBand` through this `jest-expo` preset (verified: native `bun test` fails 3 of 4 suites because `expo-crypto`/`react-native`'s Flow-syntax `index.js` doesn't parse outside Jest's Metro/babel pipeline — do not switch to the native runner).
- `client/bun.lock` — new sole client dependency lockfile, generated rather than hand-authored.

## Verification

- From `client/`, run `bun install --frozen-lockfile`; expect exit 0 and no lockfile changes.
- From `client/`, run `bun run typecheck`; expect TypeScript exit 0.
- From `client/`, run `bun run test`; expect all four current suites (`api.test.ts`, `auth.test.ts`, `session-socket.test.ts`, `ShortcutKeyboard.test.ts`) and their assertions to pass under the existing test script.
- From `client/`, run `bun run build:web`; expect Expo web export exit 0 and output in `client/dist`.
- From the repository root, run `make client-test`, `make client-build-web`, and `make lint`; expect each target to use Bun and exit 0. `make lint` also runs the unchanged backend `go vet ./...` gate.
- Search active files outside `plans/` with `grep`/the repository search tool for `npm|npx|package-lock\.json|setup-node`; expect no matches.
- Run `git diff --exit-code -- client/bun.lock` immediately after the frozen install to prove the committed lockfile is reproducible.

## Assumptions & contingencies

- “Unit tests passed using Bun” means Bun installs dependencies and launches the existing `test` package script (`jest --runInBand`) via `bun run test` — verified this session: `bun run test` passes all 4 suites / 7 tests, while native `bun test` fails 3 of 4 suites on an unparseable `react-native` Flow-typed file pulled in transitively by `expo-crypto`/`react-native` imports in `auth.test.ts`, `api.test.ts`, and `ShortcutKeyboard.test.ts`. Do not attempt the native runner as a replacement.
- Bun 1.3.14 is the pinned version because it is installed on the planning workstation. If `oven-sh/setup-bun@v2` rejects that exact version during execution, use `bun-version-file: client/package.json` while retaining the same `packageManager` version; do not silently switch to `latest`.
