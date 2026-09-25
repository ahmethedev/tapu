#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { redactUrl, resolveDatabaseUrl, scrubSecrets } from './db.js';
import { TapuError, toErrorObject } from './errors.js';
import { explain, formatExplainHuman } from './explain.js';
import { formatInitSummary, runInit } from './init.js';
import { startMcpServer } from './mcp.js';
import { formatStatusHuman, runStatus, statusExitCode } from './status.js';

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

const noUrl = () =>
  new TapuError('no_database_url', 'No database URL. Pass --db or set TAPU_DATABASE_URL or DATABASE_URL.', {
    next: 'set TAPU_DATABASE_URL',
  });

/**
 * Prints an error with every trace of the connection URL removed, then exits 2.
 * JSON-mode commands also print `{"error": {...}}` on stdout for agents.
 */
function fail(err: unknown, url: string | undefined, json: boolean): never {
  const obj = toErrorObject(err, (text) => scrubSecrets(text, url));
  if (json) process.stdout.write(JSON.stringify({ error: obj }) + '\n');
  process.stderr.write(`tapu: ${obj.message}\n`);
  process.exit(2);
}

const projectDir = () =>
  new Option('--project-dir <dir>', 'project directory holding .tapu/ and the wiki').default('.', 'current directory');

const program = new Command()
  .name('tapu')
  .description('Agent-native Postgres schema context: compile metadata once, retrieve it selectively.')
  .version(VERSION)
  .exitOverride();

program
  .command('init')
  .description('Introspect supported metadata (read-only, metadata only), write the catalog and refresh wiki pages')
  .option('--db <url>', 'Postgres connection URL (default: $TAPU_DATABASE_URL, then $DATABASE_URL)')
  .option('--schemas <list>', 'comma-separated schema names to capture; saved to .tapu/config.json')
  .option('--write-agents', 'append the Tapu paragraph to AGENTS.md if it is absent')
  .addOption(projectDir())
  .action(async (opts: { db?: string; schemas?: string; writeAgents?: boolean; projectDir: string }) => {
    const url = resolveDatabaseUrl(opts.db);
    try {
      if (!url) throw noUrl();
      const schemas = opts.schemas
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.schemas !== undefined && !schemas?.length) {
        throw new TapuError('invalid_arguments', '--schemas needs at least one schema name.');
      }
      const result = await runInit({ root: resolve(opts.projectDir), url, schemas, writeAgents: opts.writeAgents });
      process.stdout.write(formatInitSummary(result, redactUrl(url)) + '\n');
      process.exitCode = result.partial ? 2 : 0;
    } catch (err) {
      fail(err, url, false);
    }
  });

program
  .command('explain')
  .description('Schema context for agents from the local snapshot (never connects to the database)')
  .argument('[relations...]', 'relations to retrieve in detail (max 20); omit for discovery')
  .option('--search <text>', 'case-insensitive substring of relation or column names')
  .option('--limit <n>', 'discovery page size (default 50, max 100)')
  .option('--cursor <cursor>', 'continue discovery from page.nextCursor')
  .option('--related', 'add direct foreign-key neighbors of the requested relations (max 20)')
  .option('--notes', 'add human notes of the requested relations')
  .option('--rules', 'add project conventions from rules.md')
  .option('--pretty', 'indented JSON')
  .option('--human', 'readable text instead of JSON')
  .addOption(projectDir())
  .action(
    async (
      relations: string[],
      opts: {
        search?: string;
        limit?: string;
        cursor?: string;
        related?: boolean;
        notes?: boolean;
        rules?: boolean;
        pretty?: boolean;
        human?: boolean;
        projectDir: string;
      },
    ) => {
      const json = !opts.human;
      try {
        if (opts.pretty && opts.human) {
          throw new TapuError('invalid_arguments', '--pretty and --human cannot be combined.');
        }
        const limit = opts.limit === undefined ? undefined : /^\d+$/.test(opts.limit) ? Number(opts.limit) : NaN;
        const { payload, exitCode } = await explain(resolve(opts.projectDir), {
          tables: relations,
          search: opts.search,
          limit,
          cursor: opts.cursor,
          related: opts.related,
          notes: opts.notes,
          rules: opts.rules,
        });
        if (opts.human) process.stdout.write(formatExplainHuman(payload));
        else process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : undefined) + '\n');
        process.exitCode = exitCode;
      } catch (err) {
        fail(err, undefined, json);
      }
    },
  );

program
  .command('status')
  .description('Compare the live database with the saved catalog and pages (exit 0 in sync, 1 out of sync, 2 error)')
  .option('--db <url>', 'Postgres connection URL (default: $TAPU_DATABASE_URL, then $DATABASE_URL)')
  .option('--human', 'readable text instead of JSON')
  .addOption(projectDir())
  .action(async (opts: { db?: string; human?: boolean; projectDir: string }) => {
    const url = resolveDatabaseUrl(opts.db);
    try {
      if (!url) throw noUrl();
      const report = await runStatus(resolve(opts.projectDir), url);
      process.stdout.write(opts.human ? formatStatusHuman(report) : JSON.stringify(report) + '\n');
      process.exitCode = statusExitCode(report);
    } catch (err) {
      fail(err, url, !opts.human);
    }
  });

program
  .command('mcp')
  .description('Serve tapu_explain and tapu_status over stdio (no network listener)')
  .addOption(projectDir())
  .action(async (opts: { projectDir: string }) => {
    try {
      await startMcpServer(resolve(opts.projectDir), VERSION);
    } catch (err) {
      fail(err, resolveDatabaseUrl(undefined), false);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Usage errors were already printed by commander; exit 2 so they never look like drift (1).
  if (err instanceof CommanderError) process.exit(err.exitCode === 0 ? 0 : 2);
  fail(err, resolveDatabaseUrl(undefined), false);
}
