import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { UNTRUSTED_NOTICE } from '../src/sanitize.js';
import { ADMIN_URL, CLI_PATH, resetFixture, tempRoot } from './helpers.js';

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

  async function connect(env: Record<string, string> = {}): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, 'mcp'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'pipe',
    });
    client = new Client({ name: 'tapu-test', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  it('lists both tools with descriptions that steer agents', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['tapu_explain', 'tapu_status']);
    for (const tool of tools) {
      expect(tool.description).toContain('before proposing');
      expect(tool.description).toContain("'untrusted'");
    }
  });

  it('answers tools/call for tapu_explain with the CLI JSON', async () => {
    const c = await connect();
    const overview = (await c.callTool({ name: 'tapu_explain', arguments: {} })) as TextResult;
    expect(overview.isError).toBeFalsy();
    const payload = JSON.parse(overview.content[0]!.text);
    expect(payload.notice).toBe(UNTRUSTED_NOTICE);
    expect(payload.overview).toHaveLength(9);

    const full = (await c.callTool({ name: 'tapu_explain', arguments: { tables: ['orders'] } })) as TextResult;
    expect(JSON.parse(full.content[0]!.text).tables[0].t).toBe('public.orders');

    const bad = (await c.callTool({ name: 'tapu_explain', arguments: { tables: ['nope'] } })) as TextResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('Unknown relation "nope"');
  });

  it('returns a clear tool error from tapu_status without a database URL', async () => {
    const c = await connect();
    const result = (await c.callTool({ name: 'tapu_status', arguments: {} })) as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('TAPU_DATABASE_URL');
    // The server is still alive.
    expect((await c.listTools()).tools).toHaveLength(2);
  });

  it('runs tapu_status with a database URL from the environment', async () => {
    const c = await connect({ TAPU_DATABASE_URL: ADMIN_URL });
    const result = (await c.callTool({ name: 'tapu_status', arguments: {} })) as TextResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).clean).toBe(true);
  });
});
