import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
// Also works when compiled into dist/test/ (scripts/token-compare.ts imports these helpers).
const TEST_DIR = here.split(sep).includes('dist') ? join(here, '..', '..', 'test') : here;

/**
 * Admin connection for tests (owner of an explicitly designated, disposable
 * test database). There is deliberately no fallback to DATABASE_URL: the
 * fixture drops and recreates schemas.
 */
export const ADMIN_URL = (() => {
  const url = process.env.TAPU_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TAPU_TEST_DATABASE_URL is not set. Point it at a disposable test database (see docker-compose.yml); ' +
        'the tests drop and recreate schemas there.',
    );
  }
  return url;
})();

export const CLI_PATH = join(TEST_DIR, '..', 'dist', 'src', 'cli.js');
export const NET_GUARD = join(TEST_DIR, 'net-guard.mjs');

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
  const fixture = await readFile(join(TEST_DIR, 'fixture.sql'), 'utf8');
  await adminSql(`
    DROP SCHEMA IF EXISTS billing CASCADE;
    DROP SCHEMA IF EXISTS ext CASCADE;
    DROP SCHEMA IF EXISTS bulk CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
    ${fixture}
  `);
  // An invalid index: a unique index built concurrently over duplicate rows
  // fails and stays behind with indisvalid = false. CONCURRENTLY cannot run in
  // the multi-statement transaction above.
  await adminSql(`INSERT INTO public.audit_events (action) VALUES ('dup'), ('dup')`);
  await adminSql('CREATE UNIQUE INDEX CONCURRENTLY audit_events_action_key ON public.audit_events (action)').catch(
    () => {},
  );
  await adminSql('DELETE FROM public.audit_events');
}

/** Creates schema `bulk` with `count` generated tables (for pagination tests). */
export async function createBulkSchema(count: number): Promise<void> {
  await adminSql(`
    DROP SCHEMA IF EXISTS bulk CASCADE;
    CREATE SCHEMA bulk;
    DO $$
    BEGIN
      FOR i IN 1..${count} LOOP
        EXECUTE format('CREATE TABLE bulk.%I (id int PRIMARY KEY, %I text, shared_code text)',
                       'table_' || lpad(i::text, 4, '0'), 'col_' || lpad(i::text, 4, '0'));
      END LOOP;
    END $$;
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
export function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  nodeArgs: string[] = [],
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI_PATH, ...args], {
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

export const pagePath = (root: string, file: string) => join(root, 'db-wiki', 'tables', file);

/** Replaces the frontmatter of a page (between the first two `---` lines). */
export async function setFrontmatter(root: string, file: string, yaml: string): Promise<void> {
  const path = pagePath(root, file);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/^---\n[\s\S]*?\n---\n/, `---\n${yaml}\n---\n`));
}
