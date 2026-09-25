import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { AGENTS_PARAGRAPH } from '../src/wiki.js';
import { ADMIN_URL, CLI_PATH, resetFixture, tempRoot } from './helpers.js';

const readme = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');

interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const configs = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((m) => m[1]!)
  .filter((block) => block.includes('"mcpServers"'))
  .map((block) => JSON.parse(block) as { mcpServers: Record<string, ServerConfig> });

describe('README MCP setup examples', () => {
  let root: string;
  beforeAll(async () => {
    await resetFixture();
    root = await tempRoot();
    await runInit({ root, url: ADMIN_URL });
  });

  it('has a Claude Code and a Cursor example', () => {
    expect(configs).toHaveLength(2);
    expect(readme).toContain('claude mcp add --transport stdio tapu -- npx tapu mcp --project-dir "$PWD"');
    expect(readme).toContain(AGENTS_PARAGRAPH);
  });

  it.each(configs.map((c, i) => [i, c] as const))('example %i starts the server and serves both tools', async (_i, config) => {
    const server = config.mcpServers.tapu!;
    expect(server.command).toBe('npx');
    const [pkg, command, flag, dir] = server.args;
    expect([pkg, command, flag, server.args.length]).toEqual(['tapu', 'mcp', '--project-dir', 4]);
    expect(['/absolute/path/to/project', '${workspaceFolder}']).toContain(dir);
    const env = Object.fromEntries(
      Object.entries(server.env ?? {}).map(([k, v]) => {
        expect(['${TAPU_DATABASE_URL}', '${env:TAPU_DATABASE_URL}']).toContain(v);
        return [k, ADMIN_URL];
      }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, command!, flag!, root],
      cwd: '/',
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'readme-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['tapu_explain', 'tapu_status']);
      const status = (await client.callTool({ name: 'tapu_status', arguments: {} })) as { isError?: boolean };
      expect(status.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
