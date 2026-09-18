import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface GeneratedCert {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  certPath: string;
  keyPath: string;
}

export function computeCertFingerprint(certPem: string): string {
  const der = Buffer.from(
    certPem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, ''),
    'base64'
  );
  const hash = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  const pairs: string[] = [];
  for (let i = 0; i < hash.length; i += 2) {
    pairs.push(hash.slice(i, i + 2));
  }
  return pairs.join(':');
}

export function generateSelfSignedCert(outputDir: string, domains: string[] = ['localhost', '127.0.0.1']): GeneratedCert {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const certPath = path.join(outputDir, 'cert.pem');
  const keyPath = path.join(outputDir, 'key.pem');

  // Generate ECDSA P-256 key and self-signed certificate using OpenSSL
  const sanList = domains
    .map((d) => {
      const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(d) || d.includes(':');
      return isIp ? `IP:${d}` : `DNS:${d}`;
    })
    .join(',');

  const opensslConf = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = agenticRemote

[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${sanList}
`;
  const confPath = path.join(outputDir, 'openssl.cnf');
  fs.writeFileSync(confPath, opensslConf);

  try {
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "${keyPath}" -out "${certPath}" -days 365 -config "${confPath}"`,
      { stdio: 'pipe' }
    );
  } finally {
    if (fs.existsSync(confPath)) {
      fs.unlinkSync(confPath);
    }
  }

  const certPem = fs.readFileSync(certPath, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  const fingerprint = computeCertFingerprint(certPem);

  return {
    certPem,
    keyPem,
    fingerprint,
    certPath,
    keyPath,
  };
}

if (import.meta.main) {
  const out = path.join(process.cwd(), 'fixtures/generated-tls');
  const cert = generateSelfSignedCert(out, ['localhost', '127.0.0.1', 'podman-daemon']);
  console.log(`Generated test cert at ${cert.certPath}`);
  console.log(`Fingerprint: ${cert.fingerprint}`);
}
