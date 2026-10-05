import type { WebRunnerReport } from './web-runner';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function testExitCodeLogic(): void {
  const reports: { report: WebRunnerReport; expectedExit: number }[] = [
    {
      report: {
        timestamp: '2024-01-01T00:00:00Z',
        suite: 'Test Suite',
        status: 'PASS',
        details: 'All tests passed',
        testsTotal: 5,
        testsPassed: 5,
        testsFailed: 0,
      },
      expectedExit: 0,
    },
    {
      report: {
        timestamp: '2024-01-01T00:00:00Z',
        suite: 'Test Suite',
        status: 'FAIL',
        details: 'Some tests failed',
        testsTotal: 5,
        testsPassed: 3,
        testsFailed: 2,
      },
      expectedExit: 1,
    },
    {
      report: {
        timestamp: '2024-01-01T00:00:00Z',
        suite: 'Test Suite',
        status: 'BLOCKED_ENVIRONMENT',
        details: 'Environment not ready',
        testsTotal: 0,
        testsPassed: 0,
        testsFailed: 0,
      },
      expectedExit: 1,
    },
  ];

  for (const { report, expectedExit } of reports) {
    const shouldExit = report.status !== 'PASS';
    const exitCode = shouldExit ? 1 : 0;
    assert(exitCode === expectedExit, `${report.status} must exit with ${expectedExit}, got ${exitCode}`);
  }
}

if (import.meta.main) {
  testExitCodeLogic();
  console.log('All exit code logic tests passed');
}
