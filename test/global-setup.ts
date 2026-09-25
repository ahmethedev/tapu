import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds dist/ once so tests that spawn the real CLI (security, MCP) run current code. */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: root,
    stdio: 'inherit',
  });
}
