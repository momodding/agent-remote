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

export type AndroidAdbResolution =
  | { ok: true; executable: string }
  | { ok: false; searched: string[] };

/**
 * Resolve an executable from the existing host SDK without installing or downloading tooling.
 * Configured SDK roots take precedence over the home-directory convention.
 */
export function resolveAndroidAdbExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  isExecutable: (candidate: string) => boolean = (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): AndroidAdbResolution {
  const home = environment.HOME || environment.USERPROFILE || '/root';
  const sdkRoots = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT, path.join(home, 'android-sdk')]
    .filter((root): root is string => typeof root === 'string' && root.length > 0);
  const searched = [
    ...sdkRoots.map((root) => path.join(root, 'platform-tools', 'adb')),
    path.join(__dirname, '../.runtime/platform-tools/adb'),
  ];
  const executable = searched.find(isExecutable);
  return executable ? { ok: true, executable } : { ok: false, searched };
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
