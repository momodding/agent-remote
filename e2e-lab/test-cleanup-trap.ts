import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyE2eCleanup } from './cleanup/cleanup-checker';

// Minimal check verifying test-all.sh executes trap and leaves clean environment

function testCleanupTrap(): void {
  const labDir = path.resolve(__dirname);
  console.log('Testing cleanup contract in test-all.sh...');

  // Ensure down before test
  try {
    execSync('./scripts/down.sh', { cwd: labDir, stdio: 'ignore' });
  } catch {}

  // Run test-all.sh with short timeout or interrupted
  console.log('Running test-all.sh under cleanup trap test...');
  const res = spawnSync('./scripts/test-all.sh', [], {
    cwd: labDir,
    encoding: 'utf8',
    timeout: 30000, // Timeout after 30s to trigger trap/interruption
  });

  console.log(`Script finished with code: ${res.status}`);

  // Check cleanup
  const cleanup = verifyE2eCleanup(labDir);
  console.log(`Cleanup check after script run: ${cleanup.allClean ? 'ALL CLEAN' : 'ORPHANS DETECTED'}`);

  if (!cleanup.allClean) {
    console.error('Orphans found:', cleanup);
    throw new Error('Cleanup trap failed to clean test-owned resources');
  }

  console.log('PASS: test-all.sh successfully cleans up all owned resources on exit.');
}

if (import.meta.main) {
  try {
    testCleanupTrap();
    process.exit(0);
  } catch (err) {
    console.error('Trap test failed:', err);
    process.exit(1);
  }
}
