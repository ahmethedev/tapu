import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Admin connection for tests (superuser / database owner). Tapu itself never gets this role in security tests. */
export const ADMIN_URL =
  process.env.TAPU_TEST_DATABASE_URL ?? 'postgres://tapu:tapu@localhost:54329/tapu_test';

export const CLI_PATH = join(here, '..', 'dist', 'src', 'cli.js');

/** Runs SQL as the admin role (the test harness, not Tapu). */
export async function adminSql(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Drops the fixture schemas and loads test/fixture.sql from scratch. */
export async function resetFixture(): Promise<void> {
  const fixture = await readFile(join(here, 'fixture.sql'), 'utf8');
  await adminSql(`
    DROP SCHEMA IF EXISTS billing CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
    ${fixture}
  `);
}

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tapu-test-'));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI in `cwd` with a clean environment (no inherited DB URLs). */
export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
