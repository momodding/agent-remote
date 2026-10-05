import { checkRootfulKvmMapping, rootfulAndroidComposeProbeArgs } from './android-runner';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const characterDevice = { gid: 1234, isCharacterDevice: () => true };
const base = (overrides: Partial<Parameters<typeof checkRootfulKvmMapping>[0]> = {}) => ({
  stat: () => characterDevice,
  rootfulPodman: () => ({ status: 0, stdout: '{}', stderr: '' }),
  composeProbe: () => ({ status: 0, stdout: '', stderr: '' }),
  ...overrides,
});

function testADeviceMissing(): void {
  const result = checkRootfulKvmMapping(base({ stat: () => { throw new Error('ENOENT'); } }));
  assert(result.status === 'KVM_DEVICE_MISSING', 'missing /dev/kvm must have its own classification');
}

function testBDeviceMustBeCharacterDevice(): void {
  const result = checkRootfulKvmMapping(base({ stat: () => ({ gid: 1234, isCharacterDevice: () => false }) }));
  assert(result.status === 'KVM_DEVICE_MISSING', 'a non-character /dev/kvm path must block');
}

function testCRootfulAuthorization(): void {
  const result = checkRootfulKvmMapping(base({ rootfulPodman: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }) }));
  assert(result.status === 'ROOTFUL_PODMAN_AUTH_UNAVAILABLE', 'rootful authorization failure must not become a host-user KVM failure');
}

function testDMappingFailure(): void {
  const result = checkRootfulKvmMapping(base({ composeProbe: () => ({ status: 125, stdout: '', stderr: 'device setup failed' }) }));
  assert(result.status === 'ROOTFUL_KVM_MAPPING_FAILED', 'Compose/device setup failure must retain the mapping classification');
}

function testEPermissionFailure(): void {
  const result = checkRootfulKvmMapping(base({ composeProbe: () => ({ status: 42, stdout: '', stderr: 'Permission denied' }) }));
  assert(result.status === 'ROOTFUL_KVM_PERMISSION_FAILED', 'androidusr KVM denial must retain the permission classification');
}

function testFExactComposeServiceProbe(): void {
  const args = rootfulAndroidComposeProbeArgs();
  assert(args.slice(0, 5).join(' ') === 'run --rm --no-deps --entrypoint bash', 'probe must use Compose run rather than an alternate container configuration');
  assert(args.includes('android-emulator'), 'probe must use the real android-emulator service');
  assert(args.at(-1)?.includes('id -un)" = androidusr'), 'probe must verify the normal androidusr identity');
  const result = checkRootfulKvmMapping(base());
  assert(result.status === 'PASS' && result.gid === 1234, 'successful rootful service probe must pass with detected numeric gid');
}

if (import.meta.main) {
  testADeviceMissing();
  testBDeviceMustBeCharacterDevice();
  testCRootfulAuthorization();
  testDMappingFailure();
  testEPermissionFailure();
  testFExactComposeServiceProbe();
  console.log('PASS: rootful Android KVM mapping preflight checks A-F');
}
