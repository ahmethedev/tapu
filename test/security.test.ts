import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, CLI_PATH, NET_GUARD, adminSql, resetFixture, runCli, tempRoot } from './helpers.js';

const ROLE = 'tapu_connect_only';
const PASSWORD = 'Tapu-Canary-8c1f5e2d9b'; // distinctive, so any leak is easy to find
const admin = new URL(ADMIN_URL);
const DB = decodeURIComponent(admin.pathname.slice(1));
const DB_HOST = `${admin.hostname}:${admin.port || '5432'}`;

function urlFor(user: string, password: string, database = DB, port = admin.port || '5432'): string {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  u.port = port;
  return u.toString();
}

const CONNECT_ONLY_URL = urlFor(ROLE, PASSWORD);
const NEEDLES = [PASSWORD, encodeURIComponent(PASSWORD), CONNECT_ONLY_URL];

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

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function mcpClient(root: string, env: Record<string, string>, guard = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(guard ? ['--import', NET_GUARD] : []), CLI_PATH, 'mcp'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'tapu-security-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

describe('security', () => {
  beforeAll(async () => {
    await resetFixture();
    await adminSql(`
      DROP ROLE IF EXISTS ${ROLE};
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';
      GRANT CONNECT ON DATABASE "${DB}" TO ${ROLE};
      REVOKE ALL ON SCHEMA public, billing, ext FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA public, billing, ext FROM PUBLIC;
      INSERT INTO public.customers (email, full_name) VALUES ('row-canary@example.com', 'Row Canary');
    `);
  });

  afterAll(async () => {
    await adminSql(`REVOKE CONNECT ON DATABASE "${DB}" FROM ${ROLE}; DROP ROLE IF EXISTS ${ROLE};`);
    await resetFixture();
  });

  it('the restricted role has no USAGE or SELECT on the fixture', async () => {
    const client = new pg.Client({ connectionString: CONNECT_ONLY_URL });
    await client.connect();
    try {
      for (const sql of ['SELECT * FROM public.customers', 'SELECT * FROM billing.invoices', 'SELECT * FROM public.order_totals']) {
        await expect(client.query(sql)).rejects.toThrow(/permission denied/);
      }
      const { rows } = await client.query(
        `SELECT has_schema_privilege('public', 'USAGE') AS pub, has_schema_privilege('billing', 'USAGE') AS bil`,
      );
      expect(rows[0]).toEqual({ pub: false, bil: false });
    } finally {
      await client.end();
    }
  });

  it('runs init and status with only CONNECT, reads no rows, and leaks no credentials', async () => {
    const root = await tempRoot();
    const result = await runCli(['init', '--db', CONNECT_ONLY_URL, '--schemas', 'public,billing'], root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`postgres://${ROLE}:***@`);
    expect(result.stdout).toContain('12 relations');

    const catalog = JSON.parse(await readFile(join(root, '.tapu/catalog.json'), 'utf8'));
    const view = catalog.relations.find((r: { id: string }) => r.id === 'public.order_totals');
    expect(view.viewDefinition).toContain('sum(i.quantity * i.unit_price_cents)');
    expect(await grepDir(root, 'row-canary')).toEqual([]);

    const env = { TAPU_DATABASE_URL: CONNECT_ONLY_URL };
    const status = await runCli(['status'], root, env);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).result).toBe('synchronized');
    const explained = await runCli(['explain', 'customers', '--notes', '--rules'], root, env);
    expect(explained.code).toBe(0);

    const { client, stderr } = await mcpClient(root, env);
    try {
      const mcpStatus = (await client.callTool({ name: 'tapu_status', arguments: {} })) as TextResult;
      expect(mcpStatus.isError).toBeFalsy();
      for (const needle of NEEDLES) expect(JSON.stringify(mcpStatus)).not.toContain(needle);
    } finally {
      await client.close();
    }
    for (const needle of NEEDLES) {
      for (const out of [result.stdout, result.stderr, status.stdout, status.stderr, explained.stdout, explained.stderr, stderr()]) {
        expect(out).not.toContain(needle);
      }
      expect(await grepDir(root, needle), needle).toEqual([]);
    }
    expect(await grepDir(root, ROLE)).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(join(root, '.tapu/config.json'), 'utf8'))).sort()).toEqual([
      'schemas',
      'version',
      'wikiDir',
    ]);
  });

  it('scrubs the password from connection errors in CLI and MCP output', async () => {
    const root = await tempRoot();
    const cases = [
      urlFor(ROLE, PASSWORD, 'tapu_no_such_database'),
      urlFor(ROLE, PASSWORD, DB, '1'), // nothing listens on port 1
      urlFor(ROLE, `${PASSWORD}-wrong`),
      `postgres://${ROLE}:${PASSWORD}@[bad-host`, // unparseable URL
    ];
    for (const url of cases) {
      for (const args of [
        ['init', '--db', url],
        ['status', '--db', url],
      ]) {
        const result = await runCli(args, root);
        expect(result.code, `${args[0]} ${url}`).toBe(2);
        expect(result.stderr).toMatch(/^tapu: /);
        for (const needle of [PASSWORD, encodeURIComponent(PASSWORD)]) expect(result.stdout + result.stderr).not.toContain(needle);
      }
      const fromEnv = await runCli(['init'], root, { DATABASE_URL: url });
      expect(fromEnv.code).toBe(2);
      expect(fromEnv.stdout + fromEnv.stderr).not.toContain(PASSWORD);
    }
    expect(await allFiles(root)).toEqual([]);

    // A secret in a query parameter is omitted from the printed URL too.
    const withParam = await runCli(['init', '--db', `${urlFor(ROLE, PASSWORD)}?sslpassword=${PASSWORD}`], root);
    expect(withParam.code).toBe(0);
    expect(withParam.stdout).toContain(`postgres://${ROLE}:***@${DB_HOST}/${DB} (schemas`);
    expect(withParam.stdout + withParam.stderr).not.toContain(PASSWORD);
    expect(await grepDir(root, PASSWORD)).toEqual([]);

    // MCP status with a failing connection: a tool error without the password, and the server keeps running.
    const initialized = await tempRoot();
    await runCli(['init', '--db', ADMIN_URL], initialized);
    const { client, stderr } = await mcpClient(initialized, { TAPU_DATABASE_URL: urlFor(ROLE, PASSWORD, DB, '1') });
    try {
      const failed = (await client.callTool({ name: 'tapu_status', arguments: {} })) as TextResult;
      expect(failed.isError).toBe(true);
      const error = JSON.parse(failed.content[0]!.text).error;
      expect(error.code).toBe('connection_failed');
      expect(failed.content[0]!.text).not.toContain(PASSWORD);
      expect((await client.listTools()).tools).toHaveLength(2);
    } finally {
      await client.close();
    }
    expect(stderr()).not.toContain(PASSWORD);
    expect(await grepDir(initialized, PASSWORD)).toEqual([]);
  });
});

describe('local only', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const guarded = ['--import', NET_GUARD];

  it('the network guard really blocks and reports', async () => {
    const { stderr } = await promisify(execFile)(process.execPath, [
      ...guarded,
      '-e',
      `require('net').connect(80, 'example.com').on('error', () => {}); fetch('https://example.com').catch(() => {});
       try { require('net').createServer().listen(0) } catch {}`,
    ]);
    expect(stderr).toContain('TAPU_NET_GUARD connect example.com:80');
    expect(stderr).toContain('TAPU_NET_GUARD fetch https://example.com');
    expect(stderr).toContain('TAPU_NET_GUARD listen');
  });

  it('product entry points connect only to the configured Postgres server', async () => {
    const root = await tempRoot();
    const env = { TAPU_NET_ALLOW: DB_HOST, TAPU_DATABASE_URL: ADMIN_URL };
    const runs = [
      await runCli(['init'], root, env, guarded),
      await runCli(['status'], root, env, guarded),
      // explain may not connect anywhere, even with a URL configured.
      await runCli(['explain', 'orders', '--related', '--notes', '--rules'], root, { TAPU_DATABASE_URL: ADMIN_URL }, guarded),
      await runCli(['explain', '--search', 'order'], root, { TAPU_DATABASE_URL: ADMIN_URL }, guarded),
    ];
    for (const run of runs) {
      expect(run.stderr).not.toContain('TAPU_NET_GUARD');
      expect(run.code).toBe(0);
    }
  });

  it('the MCP server serves both tools without opening a socket or connecting elsewhere', async () => {
    const root = await tempRoot();
    await runCli(['init', '--db', ADMIN_URL], root);
    const { client, transport, stderr } = await mcpClient(root, { TAPU_NET_ALLOW: DB_HOST, TAPU_DATABASE_URL: ADMIN_URL }, true);
    try {
      const explained = (await client.callTool({ name: 'tapu_explain', arguments: { tables: ['orders'], related: true } })) as TextResult;
      expect(explained.isError).toBeFalsy();
      const status = (await client.callTool({ name: 'tapu_status', arguments: {} })) as TextResult;
      expect(status.isError).toBeFalsy();
      // Where lsof exists, also check the live process for listening sockets.
      const lsof = await promisify(execFile)('lsof', ['-Pan', '-p', String(transport.pid), '-iTCP', '-sTCP:LISTEN']).then(
        (r) => r.stdout,
        (err: { code?: string | number; stdout?: string }) => (err.code === 'ENOENT' ? null : (err.stdout ?? '')),
      );
      if (lsof !== null) expect(lsof).toBe('');
    } finally {
      await client.close();
    }
    expect(stderr()).not.toContain('TAPU_NET_GUARD');
  });

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
    expect(await readFile(join(srcDir, 'mcp.ts'), 'utf8')).toContain('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('introspection reads only pg_catalog and never selects from user relations', async () => {
    const text = await readFile(join(srcDir, 'introspect.ts'), 'utf8');
    const relations = [...text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/g)].map((m) => m[1]!);
    expect(relations.length).toBeGreaterThan(5);
    for (const r of relations) expect(r, r).toMatch(/^(pg_\w+|unnest|generate_series)$/);
    expect(text).not.toMatch(/count\(\*\)|information_schema|EXPLAIN\s/i);
  });

  it('path-like relation names never reach the filesystem outside the wiki', async () => {
    const root = await tempRoot();
    await runCli(['init', '--db', ADMIN_URL], root);
    for (const name of ['../../../etc/passwd', 'public."../../../etc/passwd"', '/etc/passwd', 'public.orders/../x']) {
      const result = await runCli(['explain', name], root);
      expect(result.code).toBe(2);
      expect(['invalid_name', 'unknown_relation']).toContain(JSON.parse(result.stdout).error.code);
    }
  });
});
