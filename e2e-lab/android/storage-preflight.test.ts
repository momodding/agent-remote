import {
  checkAndroidStorage,
  evaluateAndroidStorage,
  selectAndroidStorageContext,
} from './android-runner';

function info(graphRoot: string, rootless: boolean, allocated: number, used: number) {
  return {
    store: { graphRoot, runRoot: `${graphRoot}/run`, graphRootAllocated: allocated, graphRootUsed: used },
    host: { security: { rootless } },
  };
}

function context(graphRoot: string, rootless: boolean, availableBytes: number, used = 0) {
  return selectAndroidStorageContext(info(graphRoot, rootless, availableBytes + used, used), '/canonical/podman');
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

  const withUsage = context('/var/lib/containers/storage', false, 8_372_800_000, 158_697_091_072);
  assert(withUsage.availableBytes === 8_372_800_000, 'available bytes must be graphRootAllocated minus graphRootUsed');
}

function testStorageQueryIsPodmanOnly(): void {
  const calls: string[] = [];
  const preflight = checkAndroidStorage((command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === '/canonical/podman') {
      return { status: 0, stdout: JSON.stringify(info('/root-only/store', false, 8_372_800_000, 0)), stderr: '' };
    }
    throw new Error(`Unexpected command: ${command}`);
  }, '/canonical/podman');
  assert(preflight.status === 'PASS', 'storage preflight must pass using only the authorized Podman executor');
  assert(calls.length === 1, 'preflight must issue exactly one command: the authorized Podman invocation');
  assert(calls[0].startsWith('/canonical/podman '), 'the only issued command must be the authorized Podman binary');
}

function testStorageQueryMissingCapacityFieldsBlocks(): void {
  const preflight = checkAndroidStorage((command) => {
    if (command === '/canonical/podman') {
      return {
        status: 0,
        stdout: JSON.stringify({ store: { graphRoot: '/x', runRoot: '/x/run' }, host: { security: { rootless: false } } }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  }, '/canonical/podman');
  assert(preflight.status === 'BLOCKED_STORAGE_CONTEXT', 'missing graphRootAllocated/graphRootUsed must block, not crash or fabricate capacity');
}

if (import.meta.main) {
  testStoragePreflight();
  testStorageQueryIsPodmanOnly();
  testStorageQueryMissingCapacityFieldsBlocks();
  console.log('PASS: Android storage preflight context and capacity checks');
}
