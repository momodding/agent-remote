import { resolveAndroidAdbExecutable } from './env';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testConfiguredSdkWins(): void {
  const result = resolveAndroidAdbExecutable(
    { HOME: '/home/test', ANDROID_SDK_ROOT: '/sdk-root', ANDROID_HOME: '/sdk-home' },
    (candidate) => candidate === '/sdk-home/platform-tools/adb',
  );
  assert(result.ok, 'a configured Android SDK adb must resolve');
  assert(result.executable === '/sdk-home/platform-tools/adb', 'ANDROID_HOME must take precedence');
}

function testHomeSdkFallback(): void {
  const result = resolveAndroidAdbExecutable({ HOME: '/home/test' }, (candidate) => candidate === '/home/test/android-sdk/platform-tools/adb');
  assert(result.ok, 'the existing HOME/android-sdk adb must resolve');
  assert(result.executable === '/home/test/android-sdk/platform-tools/adb', 'home SDK path must be selected');
}

function testMissingAdbReportsEveryCandidate(): void {
  const result = resolveAndroidAdbExecutable({ HOME: '/home/test', ANDROID_SDK_ROOT: '/sdk-root' }, () => false);
  assert(!result.ok, 'missing ADB must fail resolution');
  assert(result.searched.includes('/sdk-root/platform-tools/adb'), 'missing result must report configured SDK path');
  assert(result.searched.includes('/home/test/android-sdk/platform-tools/adb'), 'missing result must report home SDK path');
}

if (import.meta.main) {
  testConfiguredSdkWins();
  testHomeSdkFallback();
  testMissingAdbReportsEveryCandidate();
  console.log('PASS: Android ADB resolver checks');
}
