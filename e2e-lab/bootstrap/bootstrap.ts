import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runSystemDoctor } from '../doctor/system-doctor';

export function bootstrapLab(): { success: boolean; message: string } {
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const gitkeep = path.join(artifactsDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, '');
  }

  const doc = runSystemDoctor();
  console.log(`[Bootstrap] System Doctor environment status: ${doc.overallEnvironmentStatus}`);

  // Build backend binary test validation
  try {
    const rootDir = path.join(__dirname, '../..');
    execSync('cd backend && go build -o /dev/null ./cmd/agenticRemote', {
      cwd: rootDir,
      stdio: 'inherit',
    });
    console.log('[Bootstrap] Backend Go code builds cleanly.');
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to compile backend Go binary: ${String(err)}`,
    };
  }

  return {
    success: true,
    message: 'E2E Lab bootstrap completed successfully.',
  };
}

if (import.meta.main) {
  const res = bootstrapLab();
  console.log(res.message);
}
