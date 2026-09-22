/**
 * Android Environment: Docker-Android readiness validation
 * No native SDK requirement; image sufficiency only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface AndroidEnvironment {
  imageAvailable: boolean;
  adbReady: boolean;
  env: Record<string, string>;
}

export interface AndroidEnvironmentInspection {
  status: 'READY' | 'WARN' | 'MISSING' | 'BLOCKED_ENVIRONMENT';
  blockers: string[];
  remediationSteps: string[];
}

function androidImageReference(): string {
  const versions = fs.readFileSync(path.join(__dirname, '../env/versions.env'), 'utf8');
  const value = (name: string) => versions.match(new RegExp(`^export ${name}="([^"]+)"`, 'm'))?.[1];
  const repo = value('ANDROID_IMAGE_REPO');
  const tag = value('ANDROID_IMAGE_TAG');
  const digest = value('ANDROID_IMAGE_DIGEST');
  if (!repo || !tag || !digest) throw new Error('Android image pin missing from env/versions.env');
  return `${repo}:${tag}@${digest}`;
}

export function getAndroidEnvironment(extraEnv?: Record<string, string>): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || '/root';
  const currentPath = process.env.PATH || '';

  const toolPaths = [
    path.join(home, '.maestro/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.local/bin'),
    path.join(__dirname, '../.runtime/platform-tools'),
  ];

  const extendedPath = `${toolPaths.join(':')}:${currentPath}`;
  const baseEnv = {
    ...process.env,
    PATH: extendedPath,
    ANDROID_SDK_VERSION: '34',
    ANDROID_API_LEVEL: '34',
  };

  return { ...baseEnv, ...extraEnv };
}

export async function inspectAndroidEnvironment(): Promise<AndroidEnvironmentInspection> {
  const blockers: string[] = [];
  const remediationSteps: string[] = [];
  const environment = getAndroidEnvironment();

  // 1. Validate /dev/kvm
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    blockers.push('/dev/kvm not readable/writable');
    remediationSteps.push('Ensure host has KVM support and permissions: ls -la /dev/kvm');
  }

  // 2. Validate Podman availability
  try {
    execSync('podman --version', { env: environment, stdio: 'pipe', timeout: 5000 });
  } catch {
    blockers.push('Podman not available or not executable');
    remediationSteps.push('Install Podman 4.0+ or ensure podman is in PATH');
  }

  // 3. Validate the immutable Docker-Android image, not a mutable tag.
  try {
    const image = process.env.ANDROID_IMAGE || androidImageReference();
    const result = execSync(`podman image inspect ${image} --format '{{.Id}}'`, {
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (!result) {
      blockers.push(`Docker-Android image not found: ${image}`);
      remediationSteps.push(`Pull image: podman pull ${image}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    blockers.push(`Docker-Android image not found: ${message}`);
    remediationSteps.push('Ensure Podman is running and pull the image pinned in e2e-lab/env/versions.env');
  }

  // 4. Validate host ADB and Maestro availability (required for E2E).
  const adbRemediation = process.platform === 'darwin'
    ? 'Install Android platform-tools with Homebrew: brew install android-platform-tools'
    : 'Install Android platform-tools so adb is on PATH.';
  for (const [tool, remediation] of [
    ['adb', adbRemediation],
    ['maestro', 'Install Maestro: https://maestro.mobile/'],
  ]) {
    try {
      execSync(`which ${tool}`, { env: environment, stdio: 'pipe', timeout: 5_000 });
    } catch {
      blockers.push(`${tool} CLI not found in PATH`);
      remediationSteps.push(remediation);
    }
  }
  if (blockers.length === 0) {
    return { status: 'READY', blockers: [], remediationSteps: [] };
  }

  return { status: 'BLOCKED_ENVIRONMENT', blockers, remediationSteps };
}
