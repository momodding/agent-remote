/**
 * Android Environment: PATH assembly and preflight validation
 *
 * CRITICAL: No bare podman calls. Compose orchestration uses compose.sh only.
 * Doctor may audit rootless contamination separately (read-only audit).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AndroidEnvironment {
  imageAvailable: boolean;
  adbReady: boolean;
  env: Record<string, string>;
}

/**
 * Assemble Android development environment with inherited SDK paths.
 * Ensures host ADB discovery via $HOME/android-sdk/platform-tools.
 */
export function getAndroidEnvironment(extraEnv?: Record<string, string>): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || '/root';
  const currentPath = process.env.PATH || '';

  const toolPaths = [
    path.join(home, 'android-sdk/platform-tools'), // Inherited SDK path (user installs here)
    path.join(home, '.maestro/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.local/bin'),
    path.join(__dirname, '../.runtime/platform-tools'), // Lab ephemeral fallback only
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

/**
 * KVM-only preflight check (host-side verification, not E2E).
 * No bare podman; Compose handles all container validation.
 */
export function checkKVMAccess(): { ok: boolean; error?: string } {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: '/dev/kvm not accessible. BLOCKED_EXTERNAL: Enable via rootful Podman or contact host administrator for KVM ACL adjustment.',
    };
  }
}

/**
 * Compose/E2E preflight: delegate to compose.sh for rootful validation.
 * Doctor separately audits rootless-only code paths.
 */
export function composePreflightCommand(): string[] {
  const labDir = path.resolve(__dirname, '..');
  const composeScript = path.join(labDir, 'scripts/compose.sh');
  return [composeScript, 'ps']; // Test compose.sh + sudo -n availability
}
