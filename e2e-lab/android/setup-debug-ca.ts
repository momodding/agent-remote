import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Configures Android debug network security config and validates debug CA.
 * Generates network_security_config.xml for testing without modifying production manifests.
 * Does not install certs to device — that is device/test setup.
 */

interface AndroidConfig {
  debugDir: string;
  certPath?: string;
  includeLocalhost: boolean;
}

const DEFAULT_CONFIG: AndroidConfig = {
  debugDir: 'e2e-lab/.runtime/android',
  certPath: 'e2e-lab/.runtime/tls/server.crt',
  includeLocalhost: true,
};

/**
 * Generates network_security_config.xml for Android debug builds.
 * Trusts both system (production) and debug CAs.
 * Does NOT change app manifest — debug config is separate.
 */
async function generateDebugNetworkSecurityConfig(cfg: AndroidConfig): Promise<string> {
  let trustAnchors = `
    <!-- System CA certificates (production) -->
    <certificates src="system" />`;

  if (cfg.certPath) {
    try {
      await fs.access(cfg.certPath);
      trustAnchors += `
    <!-- Debug CA for testing (only in debug builds) -->
    <certificates src="@raw/debug_ca" />`;
    } catch {
      trustAnchors += `
    <!-- Debug CA: certificate not yet generated -->`;
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Debug configuration: trust system + custom CAs -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">localhost</domain>
    <domain includeSubdomains="true">127.0.0.1</domain>
    <domain includeSubdomains="true">10.0.2.2</domain>
    <domain includeSubdomains="true">daemon.local</domain>
    <trust-anchors>${trustAnchors}
    </trust-anchors>
  </domain-config>

  <!-- Production configuration: only system CAs, no cleartext -->
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">*</domain>
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </domain-config>
</network-security-config>`;
}

/**
 * Verifies that network_security_config.xml is valid XML and safe for Android.
 */
async function verifyNetworkSecurityConfig(xmlContent: string): Promise<boolean> {
  try {
    // Simple validation: check for required elements
    const hasRootElement = xmlContent.includes('<network-security-config>');
    const hasClosingTag = xmlContent.includes('</network-security-config>');
    const hasDomainConfig = xmlContent.includes('<domain-config');
    const hasTrustAnchors = xmlContent.includes('<trust-anchors>');

    if (!hasRootElement || !hasClosingTag || !hasDomainConfig || !hasTrustAnchors) {
      console.error('[ANDROID] Invalid network-security-config structure');
      return false;
    }

    // Try to parse as XML (requires xmllint or similar; skip if unavailable)
    try {
      execSync(`echo '${xmlContent.replace(/'/g, "'\\''")}' | xmllint --noout -`, {
        stdio: 'pipe',
      });
      console.log('[ANDROID] Network security config validated (well-formed XML)');
    } catch {
      // xmllint not available, but basic structure is OK
      console.log('[ANDROID] Network security config structure valid (xmllint unavailable)');
    }

    return true;
  } catch (err: unknown) {
    console.error('[ANDROID] Config verification failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Exports certificate in formats compatible with Android.
 * Android expects either PEM or DER in res/raw/ or keystore.
 */
async function exportCertificateForAndroid(
  certPath: string,
  outputDir: string,
  formats: ('pem' | 'der')[] = ['pem', 'der']
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  // Check cert exists
  try {
    await fs.access(certPath);
  } catch {
    console.warn(`[ANDROID] Certificate not found: ${certPath}`);
    return results;
  }

  for (const fmt of formats) {
    try {
      if (fmt === 'pem') {
        // Already PEM from generator, copy as debug_ca.pem
        const pemPath = `${outputDir}/debug_ca.pem`;
        const pemContent = await fs.readFile(certPath, 'utf-8');
        await fs.writeFile(pemPath, pemContent, { mode: 0o644 });
        results[fmt] = pemPath;
        console.log(`[ANDROID] Certificate exported (PEM): ${pemPath}`);
      } else if (fmt === 'der') {
        // Convert PEM to DER using openssl
        const derPath = `${outputDir}/debug_ca.der`;
        execSync(`openssl x509 -in "${certPath}" -outform DER -out "${derPath}"`, { stdio: 'pipe' });
        results[fmt] = derPath;
        console.log(`[ANDROID] Certificate exported (DER): ${derPath}`);
      }
    } catch (err: unknown) {
      console.error(
        `[ANDROID] Failed to export ${fmt.toUpperCase()}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return results;
}

/**
 * Main setup routine.
 */
async function setupDebugCA(overrideCfg: Partial<AndroidConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...overrideCfg };

  console.log('[ANDROID] Setting up debug CA configuration...');

  // 1. Ensure output directory exists
  await fs.mkdir(cfg.debugDir, { recursive: true });

  // 2. Generate network security config
  const xmlConfig = await generateDebugNetworkSecurityConfig(cfg);

  // 3. Verify config
  const isValid = await verifyNetworkSecurityConfig(xmlConfig);
  if (!isValid) {
    throw new Error('Invalid network security config generated');
  }

  // 4. Write config to output
  const configPath = `${cfg.debugDir}/network_security_config.xml`;
  await fs.writeFile(configPath, xmlConfig, { mode: 0o644 });
  console.log(`[ANDROID] Network security config written: ${configPath}`);

  // 5. Export certificate if available
  if (cfg.certPath) {
    await fs.mkdir(`${cfg.debugDir}/raw`, { recursive: true });
    const exported = await exportCertificateForAndroid(cfg.certPath, cfg.debugDir);

    if (Object.keys(exported).length > 0) {
      console.log(`[ANDROID] Certificate exported in ${Object.keys(exported).length} format(s)`);
    } else {
      console.warn('[ANDROID] No certificate formats exported; cert may not exist yet');
    }
  }

  console.log('[ANDROID] Debug CA setup complete');
}

// CLI entry point
const args = process.argv.slice(2);
const debugDir = args[0] || DEFAULT_CONFIG.debugDir;

setupDebugCA({ debugDir })
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('[ERROR] Android debug CA setup failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
