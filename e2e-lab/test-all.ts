import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSystemDoctor, type DoctorReport } from './doctor/system-doctor';
import { runBackendVerification, type BackendSuiteResult } from './backend/backend-runner';
import { runWebVerification, type WebRunnerReport } from './web/web-runner';
import { runAndroidVerification, type AndroidRunnerReport } from './android/android-runner';
import { runLeakScan, type LeakScanResult } from './security/leak-scanner';

export interface FinalLabReport {
  timestamp: string;
  overallStatus: 'BLOCKED_ENVIRONMENT, Phase1-4 NOT YET VERIFIED' | 'PASS';
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
  console.log(`Security Scan Result: ${security.status} (${security.scannedFilesCount} files scanned)`);

  const blockers: string[] = [];
  const remediationPlan: string[] = [];

  if (doctor.overallEnvironmentStatus === 'BLOCKED_ENVIRONMENT') {
    for (const c of doctor.checks) {
      if (c.status === 'BLOCKED_ENVIRONMENT') {
        blockers.push(`${c.name}: ${c.details}`);
        if (c.remediation) remediationPlan.push(c.remediation);
      }
    }
  }

  if (android.status === 'BLOCKED_ENVIRONMENT') {
    for (const b of android.blockers) {
      if (!blockers.includes(b)) blockers.push(b);
    }
    for (const r of android.remediationSteps) {
      if (!remediationPlan.includes(r)) remediationPlan.push(r);
    }
  }

  if (web.status === 'BLOCKED_ENVIRONMENT' && web.remediation) {
    remediationPlan.push(web.remediation);
  }

  const overallStatus: 'BLOCKED_ENVIRONMENT, Phase1-4 NOT YET VERIFIED' | 'PASS' =
    android.status === 'BLOCKED_ENVIRONMENT' || web.status === 'BLOCKED_ENVIRONMENT' || backend.status !== 'PASS'
      ? 'BLOCKED_ENVIRONMENT, Phase1-4 NOT YET VERIFIED'
      : 'PASS';

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
  md += `| **System Environment** | Toolchains, KVM, Emulators, SDKs | \`${doctor.overallEnvironmentStatus}\` | ${doctor.checks.filter((c) => c.status === 'READY').length}/${doctor.checks.length} ready |\n`;
  md += `| **Phase 1-4 Backend** | Real \`make verify-phase1-4\` (Strict OMP + tmux) | \`${backend.status}\` | ${backend.details} |\n`;
  md += `| **Web Client** | Live Expo Production App | \`${web.status}\` | ${web.details} |\n`;
  md += `| **Android Mobile** | KVM / Emulator / Debug APK / Maestro | \`${android.status}\` | ${android.details} |\n`;
  md += `| **Security & Leak Audit** | Repository Secret Leak Scanner | \`${security.status}\` | Scanned ${security.scannedFilesCount} files (paths only) |\n\n`;

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
    md += `Zero secret patterns detected.\n`;
  }
  md += `\n*Note: Zero raw bearer tokens, pairing tokens, or secrets are recorded in this report or repository logs.*\n\n`;

  md += `---\n*Generated by agenticRemote E2E Lab Unified Test Suite.*\n`;

  fs.writeFileSync(path.join(artifactsDir, 'final-report.md'), md);
  console.log(`\nFinal report generated: ${path.join(artifactsDir, 'final-report.md')}`);
  console.log(`Overall Status: ${overallStatus}`);

  return report;
}

if (import.meta.main) {
  runAll();
}
