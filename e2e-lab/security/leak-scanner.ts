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
];

const IGNORE_DIRS: Record<string, true> = {
  '.git': true,
  'node_modules': true,
  'dist': true,
  'build': true,
  '.expo': true,
  'android-sdk': true,
  '.runtime': true,
  'playwright-report': true,
  'test-results': true,
};

function scanDirectory(dir: string, baseDir: string, flaggedPaths: string[]): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS[entry.name]) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      count += scanDirectory(fullPath, baseDir, flaggedPaths);
    } else if (entry.isFile()) {
      // Skip binary, image, and lock files
      if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|exe|bin|so|dylib|apk|aab|tar|gz|zip)$/i.test(entry.name)) {
        continue;
      }
      count++;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern.test(content)) {
            // Flag file path ONLY; never print secret content
            flaggedPaths.push(relPath);
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
  const flaggedPaths: string[] = [];
  const scannedFilesCount = scanDirectory(rootDir, rootDir, flaggedPaths);

  const leaksFound = flaggedPaths.length;
  const status: 'PASS' | 'FAIL' = leaksFound === 0 ? 'PASS' : 'FAIL';

  let details = '';
  if (status === 'PASS') {
    details = `Scanned ${scannedFilesCount} files across repository. Zero unredacted secrets or private keys detected.`;
  } else {
    details = `Detected ${leaksFound} files with potential unredacted secret patterns. File paths flagged for review.`;
  }

  return {
    timestamp: new Date().toISOString(),
    suite: 'Security Secret & Leak Scanner',
    status,
    scannedFilesCount,
    leaksFoundCount: leaksFound,
    flaggedPaths,
    details,
  };
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
