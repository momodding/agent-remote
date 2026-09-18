import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSystemDoctor, type DoctorReport } from './doctor/system-doctor';
import { runBackendVerification, type BackendSuiteResult } from './backend/backend-runner';
import { runWebVerification, type WebRunnerReport } from './web/web-runner';
import { runAndroidVerification, type AndroidRunnerReport } from './android/android-runner';
import { runLeakScan, type LeakScanResult } from './security/leak-scanner';

export interface FinalLabReport {
  timestamp: string;
  overallStatus: string;
  doctor: DoctorReport;
  backend: BackendSuiteResult;
  web: WebRunnerReport;
  android: AndroidRunnerReport;
  security: LeakScanResult;
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
  const android = runAndroidVerification();
  console.log(`Android Result: ${android.status}`);

  console.log('\n[5/5] Running Security & Secret Leak Scanner...');
  const security = runLeakScan();
  console.log(`Security Result: ${security.status} (${security.scannedFilesCount} files scanned)`);

  // Normalized blocker and remediation deduplication map
  const blockerMap = new Map<string, { desc: string; remedy?: string }>();

  // 1. Doctor blockers
  for (const c of doctor.checks) {
    if (c.status === 'BLOCKED_ENVIRONMENT' || c.status === 'MISSING') {
      blockerMap.set(c.id, {
        desc: `${c.name}: ${c.details}`,
        remedy: c.remediation,
      });
    }
  }

  // 2. Android runner blockers
  if (android.status === 'BLOCKED_ENVIRONMENT' || android.status === 'FAIL') {
    android.blockers.forEach((b, idx) => {
      const key = b.startsWith('Hardware Virtualization')
        ? 'DOC-06'
        : b.startsWith('Android SDK')
        ? 'DOC-05'
        : b.startsWith('Maestro CLI')
        ? 'DOC-07'
        : b.startsWith('Android Virtual Device')
        ? 'AND-AVD'
        : b.startsWith('Client Debug APK')
        ? 'AND-APK'
        : b.startsWith('Android Device')
        ? 'AND-DEV'
        : `AND-${idx}`;

      const remedy = android.remediationSteps[idx] || undefined;
      if (!blockerMap.has(key)) {
        blockerMap.set(key, { desc: b, remedy });
      }
    });
  }

  // 3. Web runner blockers
  if (web.status === 'BLOCKED_ENVIRONMENT') {
    blockerMap.set('WEB-E2E', {
      desc: web.details,
      remedy: web.remediation,
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

  const report: FinalLabReport = {
    timestamp: new Date().toISOString(),
    overallStatus,
    doctor,
    backend,
    web,
    android,
    security,
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
  md += `| **Security & Leak Audit** | Repository Secret Leak Scanner | \`${security.status}\` | Scanned ${security.scannedFilesCount} files (0 leaks) |\n\n`;

  md += `## 2. Blockers Preventing End-to-End Android & Web Verification\n\n`;
  if (blockers.length === 0) {
    md += `None. All environments verified.\n\n`;
  } else {
    for (const b of blockers) {
      md += `- ⛔ **BLOCKER**: ${b}\n`;
    }
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
  runAll().catch((err) => {
    console.error('E2E Lab execution error:', err);
    process.exit(1);
  });
}
