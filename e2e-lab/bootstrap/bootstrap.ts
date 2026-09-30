import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { runSystemDoctor } from '../doctor/system-doctor';

function ensureClientDependencies(rootDir: string): void {
  const clientDir = path.join(rootDir, 'client');
  const lockfile = fs.readFileSync(path.join(clientDir, 'bun.lock'), 'utf8');
  const expectedExpoVersion = lockfile.match(/"expo": \["expo@([^"@]+)"/)?.[1];
  const expoBin = path.join(clientDir, 'node_modules/.bin/expo');
  const installedExpoPackage = path.join(clientDir, 'node_modules/expo/package.json');
  let installedExpoVersion: string | undefined;

  try {
    installedExpoVersion = JSON.parse(fs.readFileSync(installedExpoPackage, 'utf8')).version;
    fs.accessSync(expoBin, fs.constants.X_OK);
  } catch {
    installedExpoVersion = undefined;
  }

  if (!expectedExpoVersion) {
    throw new Error('Expo version is missing from client/bun.lock');
  }

  if (installedExpoVersion !== expectedExpoVersion) {
    console.log('[Bootstrap] Installing locked client dependencies...');
    execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: clientDir, stdio: 'inherit' });
    installedExpoVersion = JSON.parse(fs.readFileSync(installedExpoPackage, 'utf8')).version;
    fs.accessSync(expoBin, fs.constants.X_OK);
  }

  if (installedExpoVersion !== expectedExpoVersion) {
    throw new Error(`Locked Expo mismatch: expected ${expectedExpoVersion}, resolved ${installedExpoVersion ?? 'missing'}`);
  }

  console.log(`[Bootstrap] Locked Expo ${installedExpoVersion} is executable at ${expoBin}.`);
}

export function bootstrapLab(): { success: boolean; message: string } {
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const gitkeep = path.join(artifactsDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, '');
  }
  const rootDir = path.join(__dirname, '../..');

  const doc = runSystemDoctor();
  console.log(`[Bootstrap] System Doctor environment status: ${doc.overallEnvironmentStatus}`);

  // Install once during setup when the lockfile-local Expo executable is absent or stale.
  try {
    ensureClientDependencies(rootDir);
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to prepare locked client dependencies: ${String(err)}`,
    };
  }

  // Build backend binary test validation
  try {
    execSync('cd backend && go build -o /dev/null ./cmd/agenticRemote', {
      cwd: rootDir,
      stdio: 'inherit',
    });
    console.log('[Bootstrap] Backend Go code builds cleanly.');
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to compile backend Go binary: ${String(err)}`,
    };
  }

  return {
    success: true,
    message: 'E2E Lab bootstrap completed successfully.',
  };
}

if (import.meta.main) {
  const res = bootstrapLab();
  console.log(res.message);
  if (!res.success) process.exitCode = 1;
}
