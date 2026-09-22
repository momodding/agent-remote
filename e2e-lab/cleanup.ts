/**
 * E2E Lab Cleanup with Safety Tiers & Preview Modes
 * normal: Tier 1 safe deletions (~750KB)
 * deep: Tier 1 + 2 (~1.4GB, requires reproducibility verification)
 * dependencies: Tier 3 optimization analysis (hermes, lightningcss, devtools, testing-library)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface CleanupItem {
  path: string;
  sizeKb: number;
  type: 'file' | 'dir';
  tier: 1 | 2 | 3;
  safe: boolean;
  reason: string;
}

interface CleanupReport {
  timestamp: string;
  mode: 'normal' | 'deep' | 'dependencies';
  totalItems: number;
  totalSizeKb: number;
  items: CleanupItem[];
  wouldDelete: boolean;
}

function getDirSizeKb(dirPath: string): number {
  try {
    const result = execSync(`du -sk "${dirPath}" 2>/dev/null | cut -f1`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

function analyzeCleanupItems(labDir: string): CleanupItem[] {
  const items: CleanupItem[] = [];

  // TIER 1: Safe deletions (ephemeral, easily regenerable)
  
  // Untracked editor temp file (kept per user requirement—not included)
  
  // Playwright test reports
  const playwrightReportDir = path.join(labDir, 'artifacts/playwright-report');
  if (fs.existsSync(playwrightReportDir)) {
    const sizeKb = getDirSizeKb(playwrightReportDir);
    items.push({
      path: playwrightReportDir,
      sizeKb,
      type: 'dir',
      tier: 1,
      safe: true,
      reason: 'Ephemeral test report; regenerated on each test run',
    });
  }

  // Test logs
  const artifactsDir = path.join(labDir, 'artifacts');
  if (fs.existsSync(artifactsDir)) {
    for (const file of fs.readdirSync(artifactsDir)) {
      if (file.endsWith('.log')) {
        const logPath = path.join(artifactsDir, file);
        const stat = fs.statSync(logPath);
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > 24) {
          const sizeKb = Math.ceil(stat.size / 1024);
          items.push({
            path: logPath,
            sizeKb,
            type: 'file',
            tier: 1,
            safe: true,
            reason: `Test log ${ageHours.toFixed(1)}h old; debugging only`,
          });
        }
      }
    }
  }

  // TIER 2: Conditional (requires verification or cache strategy)
  
  // app-debug.apk (237MB)
  const apkPath = path.join(labDir, '.runtime/app-debug.apk');
  if (fs.existsSync(apkPath)) {
    const stat = fs.statSync(apkPath);
    const sizeKb = Math.ceil(stat.size / 1024);
    items.push({
      path: apkPath,
      sizeKb,
      type: 'file',
      tier: 2,
      safe: false,
      reason: 'Expo debug build; safe only after rebuild verification and app.json SDK version pinning',
    });
  }

  // daemon-state (test isolation unknown)
  const daemonStateDir = path.join(labDir, '.runtime/daemon-state');
  if (fs.existsSync(daemonStateDir)) {
    const sizeKb = getDirSizeKb(daemonStateDir);
    items.push({
      path: daemonStateDir,
      sizeKb,
      type: 'dir',
      tier: 2,
      safe: false,
      reason: 'Test daemon persistence cache; safe only after test isolation verified',
    });
  }

  // TIER 3: Dependency optimization (analysis only, no delete)
  
  const nodeModulesDir = path.join(labDir, 'node_modules');
  if (fs.existsSync(nodeModulesDir)) {
    const sizeKb = getDirSizeKb(nodeModulesDir);
    items.push({
      path: nodeModulesDir,
      sizeKb,
      type: 'dir',
      tier: 3,
      safe: false,
      reason: 'E2E lab node_modules; safe to eliminate if all imports convert to bun builtins or via client/',
    });
  }

  const clientNodeModulesDir = path.join(labDir, '..', 'client', 'node_modules');
  if (fs.existsSync(clientNodeModulesDir)) {
    const sizeKb = getDirSizeKb(clientNodeModulesDir);
    items.push({
      path: clientNodeModulesDir,
      sizeKb,
      type: 'dir',
      tier: 3,
      safe: false,
      reason: 'Canonical client node_modules; DO NOT DELETE (per user requirement)',
    });
  }

  return items;
}

export function generateCleanupReport(
  mode: 'normal' | 'deep' | 'dependencies' = 'normal'
): CleanupReport {
  const labDir = path.join(__dirname, '..');
  const items = analyzeCleanupItems(labDir);

  let filtered = items;
  if (mode === 'normal') {
    filtered = items.filter(i => i.tier === 1);
  } else if (mode === 'deep') {
    filtered = items.filter(i => i.tier <= 2);
  } else if (mode === 'dependencies') {
    filtered = items.filter(i => i.tier === 3);
  }

  const totalSizeKb = filtered.reduce((sum, i) => sum + i.sizeKb, 0);

  return {
    timestamp: new Date().toISOString(),
    mode,
    totalItems: filtered.length,
    totalSizeKb,
    items: filtered,
    wouldDelete: mode === 'normal', // Only auto-delete Tier 1
  };
}

export async function executeCleanup(mode: 'normal' | 'deep' = 'normal'): Promise<{ deleted: number; failedCount: number; report: CleanupReport }> {
  const report = generateCleanupReport(mode);

  // Only delete in 'normal' mode (Tier 1 safe items)
  if (mode !== 'normal') {
    console.log(
      `[Cleanup] Preview mode: ${mode}. No deletions performed. Re-run with mode=normal to delete Tier 1 items.`
    );
    return { deleted: 0, failedCount: 0, report };
  }

  let deleted = 0;
  let failedCount = 0;

  for (const item of report.items) {
    if (!item.safe) {
      console.log(`[Cleanup] SKIP (unsafe): ${item.path} (${item.reason})`);
      continue;
    }

    try {
      if (item.type === 'dir') {
        execSync(`rm -rf "${item.path}"`, { stdio: 'pipe' });
      } else {
        fs.unlinkSync(item.path);
      }
      console.log(`[Cleanup] DELETED: ${item.path} (${item.sizeKb}KB)`);
      deleted++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Cleanup] FAILED: ${item.path} — ${message}`);
      failedCount++;
    }
  }

  return { deleted, failedCount, report };
}

function printReport(report: CleanupReport): void {
  console.log(`\n=== Cleanup Report: ${report.mode.toUpperCase()} ===`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Items: ${report.totalItems}, Total Size: ${report.totalSizeKb}KB`);
  console.log('');

  const byTier: Record<number, CleanupItem[]> = {};
  for (const item of report.items) {
    if (!byTier[item.tier]) byTier[item.tier] = [];
    byTier[item.tier].push(item);
  }

  for (const tier of [1, 2, 3]) {
    if (!byTier[tier]) continue;
    console.log(`\nTIER ${tier}: ${byTier[tier].length} item(s)`);
    for (const item of byTier[tier]) {
      const safeMarker = item.safe ? '✓' : '✗';
      console.log(
        `  ${safeMarker} ${item.path.split('/').pop()} — ${item.sizeKb}KB\n    ${item.reason}`
      );
    }
  }

  console.log('\nUsage:');
  console.log('  bun run cleanup --mode=normal   (Tier 1 safe; auto-delete)');
  console.log('  bun run cleanup --mode=deep     (Tier 1+2 preview; no delete)');
  console.log('  bun run cleanup --mode=dependencies  (Tier 3 analysis; no delete)');
}

if (import.meta.main) {
  const mode = (new URL(import.meta.url).searchParams.get('mode') || 'normal') as 'normal' | 'deep' | 'dependencies';

  if (mode === 'normal') {
    const result = await executeCleanup('normal');
    console.log(`\n[Cleanup] Deleted ${result.deleted} items, failed ${result.failedCount}`);
    printReport(result.report);
  } else {
    const report = generateCleanupReport(mode);
    printReport(report);
  }
}
