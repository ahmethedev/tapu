import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explain } from '../src/explain.js';
import { ADMIN_URL, adminSql, resetFixture, runCli, tempRoot } from './helpers.js';

const ROLE = 'tapu_connect_only';
const PASSWORD = 'Tapu-Canary-8c1f5e2d9b'; // distinctive, so any leak is easy to find
const admin = new URL(ADMIN_URL);
const DB = decodeURIComponent(admin.pathname.slice(1));

function urlFor(user: string, password: string, database = DB, port = admin.port || '5432'): string {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  u.port = port;
  return u.toString();
}

const CONNECT_ONLY_URL = urlFor(ROLE, PASSWORD);

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function grepDir(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await allFiles(dir)) {
    if ((await readFile(file, 'utf8')).includes(needle)) hits.push(file);
  }
  return hits;
}

describe('security', () => {
  beforeAll(async () => {
    await resetFixture();
    await adminSql(`
      DROP ROLE IF EXISTS ${ROLE};
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';
      GRANT CONNECT ON DATABASE "${DB}" TO ${ROLE};
      REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      REVOKE SELECT ON ALL TABLES IN SCHEMA billing FROM PUBLIC;
      INSERT INTO public.customers (email, full_name) VALUES ('row-canary@example.com', 'Row Canary');
    `);
  });

  afterAll(async () => {
    await adminSql(`REVOKE CONNECT ON DATABASE "${DB}" FROM ${ROLE}; DROP ROLE IF EXISTS ${ROLE};`);
    await resetFixture();
  });

  it('the CONNECT-only role really cannot read rows', async () => {
    const client = new pg.Client({ connectionString: CONNECT_ONLY_URL });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM public.customers')).rejects.toThrow(/permission denied/);
      await expect(client.query('SELECT * FROM billing.invoices')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it('runs init with only CONNECT (metadata only) and leaks no secrets to files or output', async () => {
    const root = await tempRoot();
    const result = await runCli(['init', '--db', CONNECT_ONLY_URL, '--schemas', 'public,billing'], root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`postgres://${ROLE}:***@`);

    // Everything was documented, including a schema the role has no USAGE on.
    const files = (await allFiles(root)).map((f) => f.slice(root.length + 1)).sort();
    expect(files).toContain('db-wiki/tables/billing.invoices.md');
    expect(files).toContain('db-wiki/tables/public.customers.md');

    // No row data, no password, no URL anywhere.
    for (const needle of [PASSWORD, encodeURIComponent(PASSWORD), 'row-canary', CONNECT_ONLY_URL]) {
      expect(await grepDir(root, needle), needle).toEqual([]);
      expect(result.stdout).not.toContain(needle);
      expect(result.stderr).not.toContain(needle);
    }

    const env = { TAPU_DATABASE_URL: CONNECT_ONLY_URL };
    const status = await runCli(['status'], root, env);
    expect(status.code).toBe(0);
    const explained = await runCli(['explain', 'customers', '--notes'], root, env);
    expect(explained.code).toBe(0);
    for (const out of [status.stdout, status.stderr, explained.stdout, explained.stderr]) {
      expect(out).not.toContain(PASSWORD);
    }
    expect(await grepDir(root, PASSWORD)).toEqual([]);
  });

  it('scrubs the password from connection errors', async () => {
    const root = await tempRoot();
    const cases = [
      urlFor(ROLE, PASSWORD, 'tapu_no_such_database'),
      urlFor(ROLE, PASSWORD, DB, '1'), // nothing listens on port 1
      `postgres://${ROLE}:${PASSWORD}@[bad-host`, // unparseable URL
    ];
    for (const url of cases) {
      for (const args of [['init', '--db', url], ['status', '--db', url]]) {
        const result = await runCli(args, root);
        expect(result.code, `${args[0]} ${url}`).not.toBe(0);
        expect(result.stderr).toMatch(/^tapu: /);
        expect(result.stdout + result.stderr).not.toContain(PASSWORD);
      }
      // Also when the URL only comes from the environment.
      const fromEnv = await runCli(['init'], root, { DATABASE_URL: url });
      expect(fromEnv.code).not.toBe(0);
      expect(fromEnv.stdout + fromEnv.stderr).not.toContain(PASSWORD);
    }
    expect(await allFiles(root)).toEqual([]);
  });

  it('never writes the URL into config, catalog, wiki or log', async () => {
    const root = await tempRoot();
    const result = await runCli(['init'], root, { TAPU_DATABASE_URL: CONNECT_ONLY_URL });
    expect(result.code).toBe(0);
    const config = JSON.parse(await readFile(join(root, '.tapu/config.json'), 'utf8'));
    expect(Object.keys(config).sort()).toEqual(['schemas', 'version', 'wikiDir']);
    expect(await grepDir(root, ROLE)).toEqual([]);
    expect(await grepDir(root, PASSWORD)).toEqual([]);
    await expect(explain(root)).resolves.toBeDefined();
  });
});

describe('local only', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  it('has no network code besides the Postgres driver and the stdio MCP transport', async () => {
    const forbidden = [
      /from ['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/,
      /\bfetch\(/,
      /\.listen\(/,
      /WebSocket|XMLHttpRequest/,
      /sdk\/server\/(sse|streamableHttp|websocket)/,
      /sdk\/client\//,
    ];
    for (const file of await allFiles(srcDir)) {
      const text = await readFile(file, 'utf8');
      for (const re of forbidden) expect(re.test(text), `${file} matches ${re}`).toBe(false);
    }
    const mcp = await readFile(join(srcDir, 'mcp.ts'), 'utf8');
    expect(mcp).toContain("@modelcontextprotocol/sdk/server/stdio.js");
  });

  it('introspection reads only pg_catalog', async () => {
    const text = await readFile(join(srcDir, 'introspect.ts'), 'utf8');
    const relations = [...text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/g)].map((m) => m[1]!);
    expect(relations.length).toBeGreaterThan(5);
    for (const r of relations) {
      expect(r, r).toMatch(/^(pg_\w+|unnest|generate_series)$/);
    }
    expect(text).not.toMatch(/count\(\*\)/i);
    expect(text).not.toMatch(/information_schema/i);
  });
});
