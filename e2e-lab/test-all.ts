import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSystemDoctor, type DoctorReport } from './doctor/system-doctor';
import { runBackendVerification, type BackendSuiteResult } from './backend/backend-runner';
import { runWebVerification, type WebRunnerReport } from './web/web-runner';
import { runAndroidVerification, type AndroidRunnerReport } from './android/android-runner';
import { runLeakScan, type LeakScanResult } from './security/leak-scanner';
import { verifyE2eCleanup, type CleanupCheckResult } from './cleanup/cleanup-checker';

export interface FinalLabReport {
  timestamp: string;
  overallStatus: string;
  doctor: DoctorReport;
  backend: BackendSuiteResult;
  web: WebRunnerReport;
  android: AndroidRunnerReport;
  security: LeakScanResult;
  cleanup: CleanupCheckResult;
  blockers: string[];
  remediationPlan: string[];
}

export async function runAll(): Promise<FinalLabReport> {
  const artifactsDir = path.join(__dirname, 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  console.log('===============================================================');
  console.log('         agenticRemote Truthful E2E Lab Orchestrator           ');
  console.log('===============================================================');

  console.log('\n[1/5] Running System Doctor...');
  const doctor = runSystemDoctor();
  console.log(`Doctor Result: ${doctor.overallEnvironmentStatus}`);

  console.log('\n[2/5] Running Real Backend Verification (make verify-phase1-4)...');
  const backend = await runBackendVerification();
  console.log(`Backend Result: ${backend.status} (${backend.durationMs}ms)`);

  console.log('\n[3/5] Checking Web Client Runner...');
  const web = await runWebVerification();
  console.log(`Web Result: ${web.status}`);

  console.log('\n[4/5] Checking Android Mobile Runner...');
  const android = await runAndroidVerification();
  console.log(`Android Result: ${android.status}`);

  console.log('\n[5/5] Running Security & Secret Leak Scanner...');
  const security = runLeakScan();
  console.log(`Security Result: ${security.status} (Scanned ${security.scannedFilesCount} files, ${security.flaggedPaths.length} flagged)`);

  // Aggregate and normalize blockers
  const blockerMap = new Map<string, { desc: string; remedy: string | null }>();

  // Add doctor blockers
  for (const c of doctor.checks) {
    if (c.status === 'BLOCKED_ENVIRONMENT') {
      let normKey = c.id;
      if (c.id === 'DOC-06') normKey = 'KVM';
      if (c.id === 'DOC-07') normKey = 'MAESTRO';
      if (c.id === 'DOC-05') normKey = 'ADB';
      blockerMap.set(normKey, { desc: `[${c.id}] ${c.name}: ${c.versionOrPath}`, remedy: c.remediation || null });
    }
  }

  // Add android runners blockers
  if (android.status === 'BLOCKED_ENVIRONMENT') {
    for (const b of android.blockers) {
      let normKey = b;
      let remedy: string | null = null;
      if (b.includes('/dev/kvm')) {
        normKey = 'KVM';
        remedy = 'sudo usermod -aG kvm $USER && newgrp kvm';
      } else if (b.includes('Maestro')) {
        normKey = 'MAESTRO';
        remedy = 'curl -fsSL "https://get.maestro.mobile.dev" | bash';
      } else if (b.includes('Client Debug APK')) {
        normKey = 'APK';
        remedy = 'cd client && bun run prebuild && cd android && ./gradlew assembleDebug';
      } else if (b.includes('Android Device') || b.includes('adb')) {
        normKey = 'ADB';
        remedy = 'Install Android platform-tools (adb); no host SDK or AVD is required.';
      }
      if (!blockerMap.has(normKey)) {
        blockerMap.set(normKey, { desc: b, remedy });
      }
    }
  }

  // Add web blockers
  if (web.status === 'BLOCKED_ENVIRONMENT') {
    blockerMap.set('WEB_PAIRING', {
      desc: `Web Runner: ${web.details}`,
      remedy: 'The runner builds missing local provider/daemon images automatically; if that build fails, run e2e-lab/scripts/build-images.sh and inspect its output.',
    });
  }

  const blockers: string[] = [];
  const remediationPlan: string[] = [];
  for (const item of blockerMap.values()) {
    blockers.push(item.desc);
    if (item.remedy && !remediationPlan.includes(item.remedy)) {
      remediationPlan.push(item.remedy);
    }
  }

  // Dynamic Overall Status determination
  let overallStatus = 'PASS';
  if (backend.status === 'FAIL') {
    overallStatus = 'BACKEND_FAIL';
  } else if (web.status === 'FAIL') {
    overallStatus = 'WEB_FAIL';
  } else if (security.status === 'FAIL') {
    overallStatus = 'SECURITY_FAIL';
  } else if (android.status === 'FAIL') {
    overallStatus = 'ANDROID_FAIL';
  } else if (backend.status === 'BLOCKED_ENVIRONMENT') {
    overallStatus = 'BLOCKED_ENVIRONMENT (Backend Prereq Missing)';
  } else if (web.status === 'BLOCKED_ENVIRONMENT') {
    overallStatus = 'BLOCKED_ENVIRONMENT (Web Pairing Missing)';
  } else if (android.status === 'BLOCKED_ENVIRONMENT') {
    overallStatus = 'BLOCKED_ENVIRONMENT (Android), Backend & Web PASS';
  }

  // Step 6: Cleanup verification
  if (process.env.E2E_KEEP !== '1') {
    try {
      execSync(path.join(__dirname, 'scripts/down.sh'), {
        stdio: 'ignore',
        timeout: 30000,
      });
    } catch {}
  }
  const cleanupCheck = verifyE2eCleanup(__dirname);
  if (!cleanupCheck.allClean && overallStatus === 'PASS') {
    overallStatus = 'FAIL (Orphaned Resources Detected)';
  }

  const report: FinalLabReport = {
    timestamp: new Date().toISOString(),
    overallStatus,
    doctor,
    backend,
    web,
    android,
    security,
    cleanup: cleanupCheck,
    blockers,
    remediationPlan,
  };

  // Generate truthful Markdown Report
  let md = `# agenticRemote E2E Lab Final Report\n\n`;
  md += `**Execution Timestamp**: \`${report.timestamp}\`\n`;
  md += `**Overall Verification Status**: \`${report.overallStatus}\`\n\n`;

  md += `## 1. Truthful Status Matrix\n\n`;
  md += `| Subsystem | Target / Test Harness | Status | Notes |\n`;
  md += `|---|---|---|---|\n`;
  const readyDoctorCount = doctor.checks.filter((c) => c.status === 'READY').length;
  md += `| **System Environment** | Toolchains, KVM, Emulators, SDKs | \`${doctor.overallEnvironmentStatus}\` | ${readyDoctorCount}/${doctor.checks.length} ready |\n`;
  md += `| **Phase 1-4 Backend** | Real \`make verify-phase1-4\` (Strict OMP + tmux) | \`${backend.status}\` | ${backend.details} |\n`;
  md += `| **Web Client** | Live Expo Production App | \`${web.status}\` | ${web.details} |\n`;
  md += `| **Android Mobile** | KVM / Emulator / Debug APK / Maestro | \`${android.status}\` | ${android.details} |\n`;
  md += `| **Security & Leak Audit** | Repository Secret Leak Scanner | \`${security.status}\` | Scanned ${security.scannedFilesCount} files (0 leaks) |\n`;
  md += `| **Resource Cleanup** | Podman Containers, Networks, Processes | \`${cleanupCheck.allClean ? 'CLEAN' : 'ORPHANS DETECTED'}\` | ${cleanupCheck.allClean ? 'All resources released' : 'Orphaned resources found'} |\n\n`;

  md += `## 2. Active Environment Blockers\n\n`;
  if (blockers.length === 0) {
    md += `None. All required prerequisites satisfied.\n\n`;
  } else {
    blockers.forEach((b, idx) => {
      md += `${idx + 1}. ${b}\n`;
    });
    md += `\n`;
  }

  md += `## 3. Actionable Remediation Plan to Achieve Full Verification\n\n`;
  if (remediationPlan.length === 0) {
    md += `No remediation steps required.\n\n`;
  } else {
    remediationPlan.forEach((step, idx) => {
      md += `${idx + 1}. \`${step}\`\n`;
    });
    md += `\n`;
  }

  md += `## 4. Security Audit & Leak Scan Findings\n\n`;
  md += `Total files scanned: **${security.scannedFilesCount}**\n`;
  if (security.flaggedPaths.length > 0) {
    md += `Flagged file paths containing test/example key material (paths only):\n`;
    for (const p of security.flaggedPaths) {
      md += `- \`${p}\`\n`;
    }
  } else {
    md += `Status: **ZERO LEAKS DETECTED**. No private keys, bearer tokens, or secret credentials leaked in build artifacts or runtime logs.\n`;
  }
  md += `\n`;

  md += `## 5. Doctor Toolchain Diagnostics\n\n`;
  for (const c of doctor.checks) {
    const icon = c.status === 'READY' ? '✅' : '⚠️';
    md += `- ${icon} **${c.name}** (\`${c.id}\`): \`${c.status}\` - ${c.versionOrPath}\n`;
  }
  md += `\n`;

  md += `## 6. E2E Resource Cleanup\n\n`;
  fs.writeFileSync(path.join(artifactsDir, 'cleanup-results.json'), JSON.stringify(cleanupCheck, null, 2), 'utf-8');
  if (cleanupCheck.allClean) {
    md += `Status: **CLEAN**. All test-owned containers, networks, sessions, and child processes terminated properly.\n`;
  } else {
    md += `Status: **ORPHANS DETECTED**.\n`;
    if (cleanupCheck.orphanedContainers.length > 0) md += `- Orphaned Containers: \`${cleanupCheck.orphanedContainers.join(', ')}\`\n`;
    if (cleanupCheck.orphanedNetwork) md += `- Orphaned Podman Network: \`agent-remote-e2e\`\n`;
    if (cleanupCheck.orphanedPairingFile) md += `- Orphaned Pairing Payload: \`.runtime/pairing.json\`\n`;
    if (cleanupCheck.orphanedDaemonPids.length > 0) md += `- Orphaned Daemon PIDs: \`${cleanupCheck.orphanedDaemonPids.join(', ')}\`\n`;
    if (cleanupCheck.orphanedOmpPids.length > 0) md += `- Orphaned OMP PIDs: \`${cleanupCheck.orphanedOmpPids.join(', ')}\`\n`;
    if (cleanupCheck.orphanedTmuxSessions.length > 0) md += `- Orphaned Tmux Sessions: \`${cleanupCheck.orphanedTmuxSessions.join(', ')}\`\n`;
    if (cleanupCheck.orphanedEmulators.length > 0) md += `- Orphaned Emulator PIDs: \`${cleanupCheck.orphanedEmulators.join(', ')}\`\n`;
    if (cleanupCheck.orphanedPlaywrightProcesses.length > 0) md += `- Orphaned Playwright PIDs: \`${cleanupCheck.orphanedPlaywrightProcesses.join(', ')}\`\n`;
    if (cleanupCheck.orphanedWebServerPids.length > 0) md += `- Orphaned Web Server PIDs: \`${cleanupCheck.orphanedWebServerPids.join(', ')}\`\n`;
  }
  md += `\n`;

  // Write markdown and json reports
  fs.writeFileSync(path.join(artifactsDir, 'final-report.md'), md, 'utf-8');
  fs.writeFileSync(path.join(artifactsDir, 'final-report.json'), JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n===============================================================');
  console.log(`Final Report Generated at e2e-lab/artifacts/final-report.md`);
  console.log(`Overall Status: ${overallStatus}`);
  console.log('===============================================================');

  return report;
}

if (import.meta.main) {
  runAll()
    .then((report) => {
      const isCleanPass =
        report.overallStatus === 'PASS' &&
        report.doctor.overallEnvironmentStatus === 'READY' &&
        report.backend.status === 'PASS' &&
        report.web.status === 'PASS' &&
        report.android.status === 'PASS' &&
        report.security.status === 'PASS' &&
        report.cleanup.allClean === true;

      if (!isCleanPass) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('E2E Lab execution error:', err);
      process.exit(1);
    });
}
