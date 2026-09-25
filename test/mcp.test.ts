import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { TOOLS } from '../src/mcp.js';
import { NOTICE } from '../src/sanitize.js';
import { AUTO_END } from '../src/wiki.js';
import { ADMIN_URL, CLI_PATH, adminSql, pagePath, resetFixture, tempRoot } from './helpers.js';

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

describe('tapu mcp (stdio)', () => {
  let root: string;
  let client: Client | undefined;

  beforeAll(async () => {
    await resetFixture();
    root = await tempRoot();
    await runInit({ root, url: ADMIN_URL });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  /** Starts the server from an unrelated cwd; the project comes only from --project-dir. */
  async function connect(env: Record<string, string> = {}, dir = root): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp', '--project-dir', dir],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'pipe',
    });
    client = new Client({ name: 'tapu-test', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = (await c.callTool({ name, arguments: args })) as TextResult;
    return { isError: result.isError ?? false, body: JSON.parse(result.content[0]!.text) };
  };

  it('lists two concise tools whose descriptions steer agents', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual(['tapu_explain', 'tapu_status']);
    const explainDesc = tools[0]!.description!;
    for (const phrase of ['search', 'skip discovery when names are known', '`tables`', '`related: true`', '`notes: true` and `rules: true`', 'nextCursor', 'omittedNeighbors', 'truncated', 'contextFile', "'untrusted'", 'saved snapshot']) {
      expect(explainDesc).toContain(phrase);
    }
    expect(tools[1]!.description).toContain('live database');
    expect(tools[1]!.description).toContain("'untrusted'");
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['tables', 'search', 'related', 'notes', 'rules', 'limit', 'cursor']);
    // Tool definitions are part of every agent turn; keep them small.
    expect(JSON.stringify(TOOLS).length).toBeLessThan(2600);
  });

  it('answers tapu_explain for discovery, search and batched detail', async () => {
    const c = await connect();
    const overview = await call(c, 'tapu_explain');
    expect(overview.isError).toBe(false);
    expect(overview.body.notice).toBe(NOTICE);
    expect(overview.body.overview).toHaveLength(11);

    const search = await call(c, 'tapu_explain', { search: 'email', limit: 1 });
    expect(search.body.matches).toHaveLength(1);
    const next = await call(c, 'tapu_explain', { search: 'email', limit: 1, cursor: search.body.page.nextCursor });
    expect(next.body.matches[0].t).toBe('public.orders');

    const detail = await call(c, 'tapu_explain', { tables: ['orders', 'customers'], related: true, notes: true, rules: true });
    expect(detail.body.selection.requested).toEqual(['public.orders', 'public.customers']);
    expect(detail.body.tables.length).toBeGreaterThan(2);
  });

  it('returns distinct structured tool errors and keeps serving', async () => {
    const c = await connect();
    const cases: [Record<string, unknown>, string][] = [
      [{ tables: ['nope'] }, 'unknown_relation'],
      [{ tables: ['orders'], search: 'x' }, 'invalid_arguments'],
      [{ cursor: 'garbage' }, 'cursor_invalid'],
      [{ tables: 'orders' }, 'invalid_arguments'],
      [{ bogus: true }, 'invalid_arguments'],
    ];
    for (const [args, code] of cases) {
      const r = await call(c, 'tapu_explain', args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe(code);
    }
    expect((await call(c, 'tapu_status', { x: 1 })).body.error.code).toBe('invalid_arguments');
    expect((await c.listTools()).tools).toHaveLength(2);
  });

  it('returns a clear tool error from tapu_status without a database URL', async () => {
    const c = await connect();
    const r = await call(c, 'tapu_status');
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('no_database_url');
    expect(r.body.error.message).toContain('TAPU_DATABASE_URL');
    expect((await c.listTools()).tools).toHaveLength(2);
  });

  it('reports drift as a successful result and unreliable comparisons as tool errors', async () => {
    const c = await connect({ TAPU_DATABASE_URL: ADMIN_URL });
    expect((await call(c, 'tapu_status')).body.result).toBe('synchronized');

    await adminSql('ALTER TABLE public.orders ADD COLUMN note text');
    const drift = await call(c, 'tapu_status');
    expect(drift.isError).toBe(false);
    expect(drift.body.result).toBe('out_of_sync');
    expect(drift.body.findings).toContainEqual({ code: 'relation_changed', t: 'public.orders', sections: ['columns'] });

    const file = pagePath(root, 'public.products.md');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace(AUTO_END, ''));
    try {
      const broken = await call(c, 'tapu_status');
      expect(broken.isError).toBe(true);
      expect(broken.body.result).toBe('error');
      expect(broken.body.errors[0].code).toBe('page_invalid');
      expect(broken.body.findings.length).toBeGreaterThan(0);
    } finally {
      await writeFile(file, original);
      await adminSql('ALTER TABLE public.orders DROP COLUMN note');
    }
  });

  it('fails at startup for a missing project directory', async () => {
    await expect(connect({}, '/nonexistent/tapu-project')).rejects.toThrow();
    client = undefined;
  });
});
