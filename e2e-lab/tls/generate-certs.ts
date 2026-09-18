import { generateKeyPairSync } from 'node:crypto';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

/**
 * Generates ECDSA P-256 self-signed certificate with custom SANs.
 * Writes key and cert to output directory (gitignored .runtime/).
 * Zero secrets printed to stdout.
 */

interface SAN {
  type: 'DNS' | 'IP';
  value: string;
}

interface GenerateOptions {
  outDir: string;
  keyFile: string;
  certFile: string;
  cn: string;
  daysValid: number;
}

const DEFAULT_SANS: SAN[] = [
  { type: 'IP', value: '127.0.0.1' },
  { type: 'IP', value: '10.0.2.2' },
  { type: 'DNS', value: 'localhost' },
  { type: 'DNS', value: 'daemon.local' },
];

const DEFAULT_OPTIONS: GenerateOptions = {
  outDir: 'e2e-lab/.runtime/tls',
  keyFile: 'server.key',
  certFile: 'server.crt',
  cn: 'localhost',
  daysValid: 365,
};

/**
 * Generates and self-signs ECDSA P-256 certificate with SANs.
 * Uses openssl for X.509 signing (Node crypto lacks direct signing).
 */
async function buildSignedCert(
  privateKeyPem: string,
  cn: string,
  sans: SAN[],
  daysValid: number
): Promise<string> {
  // Build SAN string for openssl (DNS:localhost,IP:127.0.0.1,...)
  const sanStr = sans.map((san) => `${san.type}:${san.value}`).join(',');

  // Write private key to temp file (process substitution not portable)
  const tmpKey = `/tmp/omp_key_${Date.now()}.pem`;
  await fs.writeFile(tmpKey, privateKeyPem, { mode: 0o600 });

  try {
    // Self-sign certificate with SANs, valid for daysValid
    // Note: openssl subj format requires /CN= not CN=
    const cmd = [
      'openssl req -x509 -new',
      `-key "${tmpKey}"`,
      `-subj "/CN=${cn}"`,
      `-days ${daysValid}`,
      `-addext "subjectAltName=${sanStr}"`,
      '-outform PEM',
    ].join(' ');

    const cert = execSync(cmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    return cert;
  } finally {
    try {
      await fs.unlink(tmpKey);
    } catch {
      // ignore cleanup failure
    }
  }
}

async function generateCerts(opts: Partial<GenerateOptions> = {}): Promise<void> {
  const config = { ...DEFAULT_OPTIONS, ...opts };

  // 1. Generate ECDSA P-256 key pair
  const keyPair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }) as { publicKey: string; privateKey: string };

  // 2. Create and sign certificate
  const certPem = await buildSignedCert(
    keyPair.privateKey,
    config.cn,
    DEFAULT_SANS,
    config.daysValid
  );

  // 3. Write to output directory (gitignored)
  await fs.mkdir(config.outDir, { recursive: true });

  const keyPath = `${config.outDir}/${config.keyFile}`;
  const certPath = `${config.outDir}/${config.certFile}`;
  const keyPemPath = `${config.outDir}/key.pem`;
  const certPemPath = `${config.outDir}/cert.pem`;
  await fs.writeFile(keyPath, keyPair.privateKey, { mode: 0o600 });
  await fs.writeFile(certPath, certPem, { mode: 0o644 });
  await fs.writeFile(keyPemPath, keyPair.privateKey, { mode: 0o600 });
  await fs.writeFile(certPemPath, certPem, { mode: 0o644 });

  // Log only paths and success status; no secrets
  console.log(`[TLS] Private key written (600): ${keyPath}`);
  console.log(`[TLS] Certificate written (644): ${certPath}`);
  console.log(`[TLS] CN=${config.cn}, Valid=${config.daysValid}d, SANs=${DEFAULT_SANS.length}`);
}

// CLI entry point
const args = process.argv.slice(2);
const outDir = args[0] || DEFAULT_OPTIONS.outDir;

generateCerts({ outDir })
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`[ERROR] Certificate generation failed:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
