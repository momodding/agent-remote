import {
  evaluateAndroidStorage,
  selectAndroidStorageContext,
} from './android-runner';

function info(graphRoot: string, rootless: boolean) {
  return {
    store: { graphRoot, runRoot: `${graphRoot}/run` },
    host: { security: { rootless } },
  };
}

function context(graphRoot: string, rootless: boolean, availableBytes: number) {
  return selectAndroidStorageContext(
    info(graphRoot, rootless),
    rootless ? 1000 : 0,
    '/canonical/podman',
    undefined,
    '/dev/test',
    '/',
    availableBytes,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testStoragePreflight(): void {
  const rootful = context('/var/lib/containers/storage', false, 8_372_800_000);
  assert(rootful.graphRoot === '/var/lib/containers/storage', 'must select the rootful GraphRoot reported by Podman info');
  assert(evaluateAndroidStorage(rootful).status === 'PASS', 'available bytes equal to required bytes must pass');

  const rootless = context('/home/user/.local/share/containers/storage', true, 9_000_000_000);
  assert(rootless.graphRoot === '/home/user/.local/share/containers/storage', 'must report rootless GraphRoot when Podman reports it');
  assert(evaluateAndroidStorage(rootless).status === 'BLOCKED_STORAGE_CONTEXT', 'rootless context must not be used by the rootful harness');

  const projectLocal = context('/repo/e2e-lab/.runtime/podman-system-graphroot', false, 9_000_000_000);
  assert(projectLocal.graphRoot === '/repo/e2e-lab/.runtime/podman-system-graphroot', 'must report Podman info GraphRoot without substituting a hard-coded path');

  const insufficient = context('/var/lib/containers/storage', false, 8_372_799_999);
  assert(evaluateAndroidStorage(insufficient).status === 'BLOCKED_INSUFFICIENT_STORAGE', 'available bytes below required bytes must block');
}

if (import.meta.main) {
  testStoragePreflight();
  console.log('PASS: Android storage preflight context and capacity checks');
}
