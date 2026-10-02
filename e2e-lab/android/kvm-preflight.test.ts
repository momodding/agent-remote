import { evaluateKvmPreflight } from './android-runner';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testKvmAccessibleDoesNotBlock(): void {
  const result = evaluateKvmPreflight({ ok: true });
  assert(result.blocked === false, 'accessible KVM must not block the harness');
}

function testKvmInaccessibleBlocksWithDetails(): void {
  const result = evaluateKvmPreflight({ ok: false, error: '/dev/kvm not accessible. BLOCKED_EXTERNAL: Enable via rootful Podman or contact host administrator for KVM ACL adjustment.' });
  assert(result.blocked === true, 'inaccessible KVM must block before Compose starts (regression for the inverted !kvmCheck guard)');
  assert(result.details.includes('/dev/kvm not accessible'), 'blocked result must surface the underlying KVM error for diagnosis');
}

function testKvmInaccessibleWithoutErrorStillBlocks(): void {
  const result = evaluateKvmPreflight({ ok: false });
  assert(result.blocked === true, 'inaccessible KVM must block even if no error string is provided');
  assert(result.details.length > 0, 'blocked result must always carry a non-empty details message');
}

if (import.meta.main) {
  testKvmAccessibleDoesNotBlock();
  testKvmInaccessibleBlocksWithDetails();
  testKvmInaccessibleWithoutErrorStillBlocks();
  console.log('PASS: Android KVM preflight short-circuit checks');
}
