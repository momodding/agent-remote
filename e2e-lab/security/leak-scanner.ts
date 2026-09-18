import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LeakScanResult {
  timestamp: string;
  suite: 'Security Secret & Leak Scanner';
  status: 'PASS' | 'FAIL';
  scannedFilesCount: number;
  leaksFoundCount: number;
  flaggedPaths: string[];
  details: string;
}

const SUSPICIOUS_PATTERNS = [
  /-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----/i,
  /(?:bearer\s+[a-zA-Z0-9_\-\.]{30,})/i,
  /(?:pairingSecret\s*[:=]\s*["'][a-zA-Z0-9_\-\.]{16,}["'])/i,
  /(?:bridgeSecret\s*[:=]\s*["'][a-zA-Z0-9_\-\.]{16,}["'])/i,
  /(?:token\s*=\s*[a-zA-Z0-9_\-]{24,})/i,
];

const IGNORE_DIRS: Record<string, true> = {
  'examples': true,
  'node_modules': true,
  'dist': true,
  'build': true,
  '.expo': true,
  'android-sdk': true,
  'playwright-report': true,
  'test-results': true,
};

function scanDirectory(dir: string, baseDir: string, flaggedPathsSet: Set<string>): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS[entry.name]) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      count += scanDirectory(fullPath, baseDir, flaggedPathsSet);
    } else if (entry.isFile()) {
      if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|exe|bin|so|dylib|apk|aab|tar|gz|zip)$/i.test(entry.name)) {
        continue;
      }

      // Allow intentional TLS private key files under .runtime/tls/ or certs/
      const isIntentionalKeyFile = (fullPath.includes('/.runtime/tls/') || fullPath.includes('/certs/')) &&
        /\.(key|pem|der)$/i.test(entry.name);

      count++;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern === SUSPICIOUS_PATTERNS[0] && isIntentionalKeyFile) {
            // Private key is expected inside the dedicated server.key file
            continue;
          }

          if (pattern.test(content)) {
            // Report file path ONLY; never print secret content
            flaggedPathsSet.add(relPath || fullPath);
            break;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
  return count;
}

export function runLeakScan(): LeakScanResult {
  const rootDir = path.join(__dirname, '../..');
  const labDir = path.join(__dirname, '..');
  const flaggedPathsSet = new Set<string>();

  // 1. Scan repo files (excluding build dirs)
  let scannedFilesCount = scanDirectory(rootDir, rootDir, flaggedPathsSet);

  // 2. Scan e2e-lab/.runtime explicitly
  const runtimeDir = path.join(labDir, '.runtime');
  if (fs.existsSync(runtimeDir)) {
    scannedFilesCount += scanDirectory(runtimeDir, rootDir, flaggedPathsSet);
  }

  // 3. Scan e2e-lab/artifacts explicitly
  const artifactsDir = path.join(labDir, 'artifacts');
  if (fs.existsSync(artifactsDir)) {
    scannedFilesCount += scanDirectory(artifactsDir, rootDir, flaggedPathsSet);
  }

  // 4. Scan test-owned /tmp runtime paths if they exist
  const tmpTargets = [
    '/tmp/bridge_debug.log',
    '/tmp/agenticremote-test.log',
    '/tmp/omp-daemon.log',
  ];

  for (const tmpFile of tmpTargets) {
    if (fs.existsSync(tmpFile)) {
      scannedFilesCount++;
      try {
        const content = fs.readFileSync(tmpFile, 'utf8');
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern.test(content)) {
            flaggedPathsSet.add(tmpFile);
            break;
          }
        }
      } catch {
        // Skip unreadable
      }
    }
  }

  // 5. Scan any /tmp/runtime* directories created during test runs
  try {
    const tmpEntries = fs.readdirSync('/tmp', { withFileTypes: true });
    for (const ent of tmpEntries) {
      if (ent.isDirectory() && ent.name.startsWith('agenticremote-runtime-')) {
        scannedFilesCount += scanDirectory(path.join('/tmp', ent.name), rootDir, flaggedPathsSet);
      }
    }
  } catch {
    // Skip unreadable /tmp
  }

  const flaggedPaths = Array.from(flaggedPathsSet);
  const leaksFound = flaggedPaths.length;
  const status: 'PASS' | 'FAIL' = leaksFound === 0 ? 'PASS' : 'FAIL';

  let details = '';
  if (status === 'PASS') {
    details = `Scanned ${scannedFilesCount} files across repository, runtime, and artifacts. Zero unredacted secrets or leaked tokens detected.`;
  } else {
    details = `Detected ${leaksFound} files with potential unredacted secret patterns. File paths flagged for review.`;
  }

  const res: LeakScanResult = {
    timestamp: new Date().toISOString(),
    suite: 'Security Secret & Leak Scanner',
    status,
    scannedFilesCount,
    leaksFoundCount: leaksFound,
    flaggedPaths,
    details,
  };

  try {
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(artifactsDir, 'security-results.json'), JSON.stringify(res, null, 2));
    let log = `=================================================================\n`;
    log += `        SECURITY LEAK SCAN REPORT                                \n`;
    log += `=================================================================\n`;
    log += `Timestamp: ${res.timestamp}\n`;
    log += `Status: ${res.status}\n`;
    log += `Files Scanned: ${res.scannedFilesCount}\n`;
    log += `Leaks Detected: ${res.leaksFoundCount}\n\n`;
    if (flaggedPaths.length > 0) {
      log += `Flagged Paths (Path-only reporting):\n`;
      for (const p of flaggedPaths) {
        log += `  - ${p}\n`;
      }
    }
    fs.writeFileSync(path.join(artifactsDir, 'security.log'), log);
  } catch {
    // Ignore fallback
  }

  return res;
}

if (import.meta.main) {
  const rep = runLeakScan();
  console.log(`Leak Scanner Status: ${rep.status} (${rep.scannedFilesCount} files scanned)`);
  if (rep.flaggedPaths.length > 0) {
    console.log('Flagged paths (reporting paths only):');
    rep.flaggedPaths.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
}
