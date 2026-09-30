#!/usr/bin/env bun
/**
 * Smoke test: security-runner integration only (backend/web/android disabled)
 * Verifies that security-runner spawns, captures output, times out, and writes artifacts
 */
import { runSecurityVerification } from './security/security-runner';

async function main() {
  console.log('=== Security Runner Smoke Test ===\n');
  
  const result = await runSecurityVerification(5 * 60 * 1000); // 5min timeout
  
  console.log(`\nResult:`);
  console.log(`  success: ${result.success}`);
  console.log(`  exitCode: ${result.exitCode}`);
  console.log(`  durationMs: ${result.durationMs}`);
  console.log(`  startedAt: ${result.startedAt}`);
  console.log(`  completedAt: ${result.completedAt}`);
  console.log(`\nArtifacts:`);
  console.log(`  .started:   ${result.startedArtifact || '(not set)'}`);
  console.log(`  .log:       ${result.logArtifact || '(not set)'}`);
  console.log(`  .exit:      ${result.exitArtifact || '(not set)'}`);
  console.log(`  .completed: ${result.completedArtifact || '(not set)'}`);
  
  if (!result.success) {
    console.log(`\nError: ${result.error || '(none)'}`);
  }
  
  process.exit(result.success ? 0 : 1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
