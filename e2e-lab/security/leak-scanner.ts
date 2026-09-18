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
  '.git': true,
  'examples': true,
  'node_modules': true,
  'dist': true,
  'build': true,
  '.expo': true,
  'android-sdk': true,
  'playwright-report': true,
  'test-results': true,
  'coverage': true,
  '.runtime': true,
  'artifacts': true,
};

function scanDirectory(
  dir: string,
  baseDir: string,
  flaggedPathsSet: Set<string>,
  visitedFiles: Set<string>,
  customIgnoreDirs: Record<string, true> = IGNORE_DIRS
): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (customIgnoreDirs[entry.name]) continue;

    const fullPath = path.resolve(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      count += scanDirectory(fullPath, baseDir, flaggedPathsSet, visitedFiles, customIgnoreDirs);
    } else if (entry.isFile()) {
      if (visitedFiles.has(fullPath)) {
        continue;
      }
      visitedFiles.add(fullPath);

      if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|exe|bin|so|dylib|apk|aab|tar|gz|zip|lock|lockb)$/i.test(entry.name)) {
        continue;
      }

      // Allow intentional TLS private key files under .runtime/tls/ or certs/
      const isIntentionalKeyFile =
        (fullPath.includes('/.runtime/tls/') || fullPath.includes('/certs/')) &&
        /\.(key|pem|der)$/i.test(entry.name);

      count++;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern === SUSPICIOUS_PATTERNS[0] && isIntentionalKeyFile) {
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
  const rootDir = path.resolve(__dirname, '../..');
  const labDir = path.resolve(__dirname, '..');
  const flaggedPathsSet = new Set<string>();
  const visitedFiles = new Set<string>();

  // 1. Scan repo tree (skipping .git, .runtime, artifacts, node_modules)
  let scannedFilesCount = scanDirectory(rootDir, rootDir, flaggedPathsSet, visitedFiles, IGNORE_DIRS);

  // 2. Scan e2e-lab/.runtime explicitly once
  const runtimeDir = path.join(labDir, '.runtime');
  if (fs.existsSync(runtimeDir)) {
    scannedFilesCount += scanDirectory(runtimeDir, rootDir, flaggedPathsSet, visitedFiles, {});
  }

  // 3. Scan e2e-lab/artifacts explicitly once
  const artifactsDir = path.join(labDir, 'artifacts');
  if (fs.existsSync(artifactsDir)) {
    scannedFilesCount += scanDirectory(artifactsDir, rootDir, flaggedPathsSet, visitedFiles, {});
  }

  // 4. Scan test-owned /tmp runtime paths if they exist
  const tmpTargets = [
    '/tmp/bridge_debug.log',
    '/tmp/agenticremote-test.log',
  ];

  for (const tmpPath of tmpTargets) {
    if (fs.existsSync(tmpPath)) {
      if (visitedFiles.has(tmpPath)) continue;
      visitedFiles.add(tmpPath);

      scannedFilesCount++;
      try {
        const content = fs.readFileSync(tmpPath, 'utf8');
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern.test(content)) {
            flaggedPathsSet.add(tmpPath);
            break;
          }
        }
      } catch {
        // Ignore unreadable tmp
      }
    }
  }

  const flaggedPaths = Array.from(flaggedPathsSet);
  const status: 'PASS' | 'FAIL' = flaggedPaths.length === 0 ? 'PASS' : 'FAIL';

  const result: LeakScanResult = {
    timestamp: new Date().toISOString(),
    suite: 'Security Secret & Leak Scanner',
    status,
    scannedFilesCount,
    leaksFoundCount: flaggedPaths.length,
    flaggedPaths,
    details:
      status === 'PASS'
        ? `Leak scanner inspected ${scannedFilesCount} files; 0 plaintext credentials or leaked secrets found.`
        : `Leak scanner detected ${flaggedPaths.length} file(s) with leaked credentials!`,
  };

  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(artifactsDir, 'security-leak-scan.json'),
    JSON.stringify(result, null, 2),
    'utf-8'
  );

  return result;
}

if (import.meta.main) {
  const r = runLeakScan();
  console.log(`Leak Scanner Status: ${r.status}`);
  console.log(`Files scanned: ${r.scannedFilesCount}`);
  console.log(`Leaks found: ${r.leaksFoundCount}`);
  if (r.flaggedPaths.length > 0) {
    console.log('Flagged paths:');
    r.flaggedPaths.forEach((p) => console.log(`  - ${p}`));
  }
}
