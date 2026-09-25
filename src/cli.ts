#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { errorMessage, redactUrl, resolveDatabaseUrl, scrubSecrets } from './db.js';
import { explain, formatExplainHuman } from './explain.js';
import { formatInitSummary, runInit } from './init.js';
import { startMcpServer } from './mcp.js';
import { formatStatusHuman, runStatus, statusExitCode } from './status.js';

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

const NO_URL = 'No database URL. Pass --db or set TAPU_DATABASE_URL or DATABASE_URL.';

/** Prints an error with every trace of the connection URL removed, then exits. */
function fail(err: unknown, url: string | undefined, code: number): never {
  process.stderr.write(`tapu: ${scrubSecrets(errorMessage(err), url)}\n`);
  process.exit(code);
}

const program = new Command()
  .name('tapu')
  .description('Agent-native memory layer for Postgres: a living, verified wiki of your schema.')
  .version(VERSION)
  .exitOverride();

program
  .command('init')
  .description('Introspect the schema (read-only, metadata only) and write .tapu/ and the wiki')
  .option('--db <url>', 'Postgres connection URL (default: $TAPU_DATABASE_URL or $DATABASE_URL)')
  .option('--schemas <list>', 'comma-separated schemas to document; saved to .tapu/config.json')
  .option('--write-agents', 'append the Tapu line to AGENTS.md if missing')
  .action(async (opts: { db?: string; schemas?: string; writeAgents?: boolean }) => {
    const url = resolveDatabaseUrl(opts.db);
    try {
      if (!url) throw new Error(NO_URL);
      const schemas = opts.schemas
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await runInit({ root: process.cwd(), url, schemas, writeAgents: opts.writeAgents });
      process.stdout.write(formatInitSummary(result, redactUrl(url)) + '\n');
    } catch (err) {
      fail(err, url, 1);
    }
  });

program
  .command('explain')
  .description('Print schema knowledge for agents (no database connection)')
  .argument('[tables...]', 'relations to explain in full; omit for an overview')
  .option('--pretty', 'indented JSON')
  .option('--human', 'readable text instead of JSON')
  .option('--notes', "include each page's free-text notes (under 'untrusted')")
  .action(async (tables: string[], opts: { pretty?: boolean; human?: boolean; notes?: boolean }) => {
    try {
      const payload = await explain(process.cwd(), { tables, notes: opts.notes });
      if (opts.human) process.stdout.write(formatExplainHuman(payload));
      else process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : undefined) + '\n');
    } catch (err) {
      fail(err, undefined, 1);
    }
  });

program
  .command('status')
  .description('Detect drift between the catalog/wiki and the live database (exit 0 clean, 1 drift, 2 error)')
  .option('--db <url>', 'Postgres connection URL (default: $TAPU_DATABASE_URL or $DATABASE_URL)')
  .option('--human', 'readable text instead of JSON')
  .action(async (opts: { db?: string; human?: boolean }) => {
    const url = resolveDatabaseUrl(opts.db);
    try {
      if (!url) throw new Error(NO_URL);
      const report = await runStatus(process.cwd(), url);
      process.stdout.write(opts.human ? formatStatusHuman(report) : JSON.stringify(report) + '\n');
      process.exitCode = statusExitCode(report);
    } catch (err) {
      if (!opts.human) process.stdout.write(JSON.stringify({ error: scrubSecrets(errorMessage(err), url) }) + '\n');
      fail(err, url, 2);
    }
  });

program
  .command('mcp')
  .description('Start a local MCP server on stdio exposing tapu_explain and tapu_status')
  .action(async () => {
    try {
      await startMcpServer(process.cwd(), VERSION);
    } catch (err) {
      fail(err, resolveDatabaseUrl(undefined), 1);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Usage errors were already printed by commander; exit 2 so they never look like drift (1).
  if (err instanceof CommanderError) process.exit(err.exitCode === 0 ? 0 : 2);
  fail(err, resolveDatabaseUrl(undefined), 2);
}
