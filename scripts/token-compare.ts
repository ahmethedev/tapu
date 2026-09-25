/**
 * Representation-size and local-latency report (spec §14.1). Evaluation only:
 * the information_schema baseline below is never used by the product.
 *
 * Usage: TAPU_TEST_DATABASE_URL=postgres://… npm run token-compare [-- --runs 30] [--bulk 500]
 *
 * Reloads test/fixture.sql into that disposable test database. Sizes are
 * character counts; "≈tokens" is characters / 4, an estimate, not a
 * tokenizer measurement.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import type { Catalog, Relation } from '../src/catalog.js';
import { withSession } from '../src/db.js';
import { explain, type DetailPayload, type DiscoveryPayload, type ExplainRequest } from '../src/explain.js';
import { quoteIdent } from '../src/ident.js';
import { runInit } from '../src/init.js';
import { TOOLS } from '../src/mcp.js';
import { runStatus } from '../src/status.js';
import { ADMIN_URL, CLI_PATH, createBulkSchema, resetFixture } from '../test/helpers.js';
import { applyExampleNotes } from '../test/fixture-notes.js';

const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const RUNS = Number(argValue('--runs') ?? 30);
const BULK = argValue('--bulk') === undefined ? 0 : Number(argValue('--bulk'));

const size = (text: string) => `${text.length} chars ≈${Math.round(text.length / 4)} tokens`;
const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));

/** Rows as `psql -A` prints them: a header line, then one `|`-separated line per row. */
function unaligned(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return [cols.join('|'), ...rows.map((r) => cols.map((c) => cell(r[c])).join('|'))].join('\n') + '\n';
}

async function payload<T>(root: string, req: ExplainRequest): Promise<T> {
  return (await explain(root, req)).payload as T;
}

// ---------------------------------------------------------------------------
// D: a competent compact baseline with the same supported facts as C

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function ddl(rel: Relation, catalog: Catalog, sensitive: (rel: Relation, col: string) => boolean): string {
  const out: string[] = [];
  if (rel.kind === 'view' || rel.kind === 'materialized_view') {
    out.push(`CREATE ${rel.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW'} ${rel.id} AS\n${rel.viewDefinition!.trim()}`);
    out.push(`-- columns: ${rel.columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ')}`);
  } else {
    const lines = rel.columns.map((c) => {
      let s = `  ${quoteIdent(c.name)} ${c.type}`;
      if (c.identity) s += ` GENERATED ${c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      if (c.generated) s += ` GENERATED ALWAYS AS ${c.generated} STORED`;
      if (c.default !== null) s += ` DEFAULT ${c.default}`;
      if (!c.nullable) s += ' NOT NULL';
      if (sensitive(rel, c.name)) s += ' /* sensitive */';
      return s;
    });
    const cons = [rel.primaryKey, ...rel.uniques, ...rel.checks, ...rel.foreignKeys]
      .filter((k) => k !== null)
      .map((k) => `  CONSTRAINT ${quoteIdent(k!.name)} ${k!.definition}`);
    out.push(`CREATE TABLE ${rel.id} (\n${[...lines, ...cons].join(',\n')}\n)${rel.partitionKey ? ` PARTITION BY ${rel.partitionKey}` : ''};`);
  }
  for (const ix of rel.indexes.filter((i) => i.constraint === null)) out.push(`${ix.definition};${ix.valid ? '' : ' -- invalid'}`);
  if (rel.referencedBy.length > 0) {
    out.push(`-- referenced by: ${rel.referencedBy.map((r) => `${r.from}(${r.columns.map(quoteIdent).join(', ')})`).join(', ')}`);
  }
  if (rel.rows !== null) out.push(`-- estimated rows: ${rel.rows}`);
  if (rel.comment) out.push(`COMMENT ON TABLE ${rel.id} IS ${lit(rel.comment)};`);
  for (const c of rel.columns) if (c.comment) out.push(`COMMENT ON COLUMN ${rel.id}.${quoteIdent(c.name)} IS ${lit(c.comment)};`);
  for (const fk of rel.foreignKeys) {
    if (!catalog.relations.some((r) => r.id === fk.ref)) out.push(`-- ${fk.ref} is outside the captured schemas`);
  }
  return out.join('\n');
}

function baseline(catalog: Catalog, detail: DetailPayload, search: DiscoveryPayload, prose: boolean): string {
  const ids = [...detail.selection.requested, ...(detail.selection.neighbors ?? [])];
  const rels = ids.map((id) => catalog.relations.find((r) => r.id === id)!);
  const sensitiveCols = new Map(detail.tables.map((t) => [t.t, new Set((t.cols ?? []).filter((c) => c.includes(' SENSITIVE')).map((c) => c.split(' ')[0]!))]));
  const sensitive = (rel: Relation, col: string) => sensitiveCols.get(rel.id)?.has(quoteIdent(col)) ?? false;
  const parts: string[] = [];
  // Discovery equivalent: `SELECT table_schema, table_name, column_name … WHERE column_name ILIKE '%email%'`.
  parts.push(
    'table|matching columns\n' +
      (search.matches ?? []).map((m) => `${m.t}|${(m.matchedCols ?? []).join(',')}`).join('\n'),
  );
  const enumIds = new Set(detail.enums?.map((e) => e.t) ?? []);
  for (const e of catalog.enums.filter((x) => enumIds.has(x.id))) {
    parts.push(`CREATE TYPE ${e.id} AS ENUM (${e.values.map(lit).join(', ')});${e.external ? ' -- outside the captured schemas' : ''}`);
  }
  for (const rel of rels) parts.push(ddl(rel, catalog, sensitive));
  if (prose) {
    for (const t of detail.tables) {
      const u = t.untrusted;
      if (!u) continue;
      const lines = [`-- ${t.t}`];
      if (u.purpose) lines.push(`purpose: ${u.purpose}`);
      if (u.owner) lines.push(`owner: ${u.owner}`);
      if (u.tags) lines.push(`tags: ${u.tags.join(', ')}`);
      for (const [c, n] of Object.entries(u.colNotes ?? {})) lines.push(`note on ${c}: ${n}`);
      if (u.notes) lines.push(u.notes);
      if (lines.length > 1) parts.push(lines.join('\n'));
    }
    if (detail.untrusted?.rules) parts.push(detail.untrusted.rules);
  }
  return parts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Breakdown of a Tapu workflow

interface Call {
  label: string;
  args: ExplainRequest;
  response: DiscoveryPayload | DetailPayload;
}

function breakdown(calls: Call[]) {
  const tools = JSON.stringify(TOOLS);
  let overhead = 0;
  let discovery = 0;
  let structure = 0;
  let prose = 0;
  let args = 0;
  let total = tools.length;
  for (const c of calls) {
    const r = c.response;
    const text = JSON.stringify(r);
    total += text.length + JSON.stringify(c.args).length;
    args += JSON.stringify(c.args).length;
    overhead += json(r.notice).length + json(r.source).length + json(r.coverage).length + json(r.contextFiles).length;
    prose += json(r.untrusted).length;
    if ('page' in r) {
      discovery += json(r.page).length + json(r.overview ?? r.matches).length + json(r.search).length;
    } else {
      for (const t of r.tables) {
        const { untrusted, ...rest } = t;
        structure += JSON.stringify(rest).length;
        prose += json(untrusted).length;
      }
      structure += json(r.selection).length + json(r.enums).length;
    }
  }
  const other = total - tools.length - args - overhead - discovery - structure - prose;
  return { total, tools: tools.length, args, overhead, discovery, structure, prose, other };
}

function printWorkflow(title: string, calls: Call[]): number {
  const b = breakdown(calls);
  console.log(`\n${title}: ${calls.length} tool calls`);
  for (const c of calls) console.log(`  call ${c.label}: ${JSON.stringify(c.args)} -> ${size(JSON.stringify(c.response))}`);
  console.log(`  tool definitions (tools/list, once):  ${size('x'.repeat(b.tools))}`);
  console.log(`  call arguments:                       ${size('x'.repeat(b.args))}`);
  console.log(`  shared envelopes (notice, source, …): ${size('x'.repeat(b.overhead))}`);
  console.log(`  discovery entries:                    ${size('x'.repeat(b.discovery))}`);
  console.log(`  selected structure:                   ${size('x'.repeat(b.structure))}`);
  console.log(`  human prose (untrusted):              ${size('x'.repeat(b.prose))}`);
  console.log(`  JSON punctuation and keys (other):    ${size('x'.repeat(b.other))}`);
  console.log(`  workflow total:                       ${size('x'.repeat(b.total))}`);
  return b.total;
}

// ---------------------------------------------------------------------------
// Latency

function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return `min ${sorted[0]!.toFixed(1)} ms, median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms (n=${times.length})`;
}

async function time(runs: number, fn: () => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return out;
}

async function latency(root: string, label: string, detailTables: string[], search: string): Promise<void> {
  console.log(`\nLocal latency, ${label}`);
  const first = await time(1, () => explain(root, { tables: detailTables, related: true }));
  console.log(`  explain detail, first call in this process (cold module/file cache): ${first[0]!.toFixed(1)} ms`);
  console.log(`  explain overview (warm, in-process):            ${stats(await time(RUNS, () => explain(root)))}`);
  console.log(`  explain --search ${search} (warm, in-process):   ${stats(await time(RUNS, () => explain(root, { search })))}`);
  console.log(
    `  explain detail --related (warm, in-process):    ${stats(await time(RUNS, () => explain(root, { tables: detailTables, related: true })))}`,
  );
  const cli = await time(Math.min(RUNS, 10), async () =>
    execFileSync(process.execPath, [CLI_PATH, 'explain', '--project-dir', root, ...detailTables, '--related'], { stdio: 'pipe' }),
  );
  console.log(`  CLI process explain detail (incl. Node startup): ${stats(cli)}`);
  console.log(`  status, live comparison:                         ${stats(await time(Math.min(RUNS, 10), () => runStatus(root, ADMIN_URL)))}`);
  console.log(`  init, unchanged database:                        ${stats(await time(Math.min(RUNS, 5), () => runInit({ root, url: ADMIN_URL })))}`);
}

// ---------------------------------------------------------------------------

await resetFixture();
const schemas = ['public'];
const root = await mkdtemp(join(os.tmpdir(), 'tapu-token-compare-'));
try {
  const initTime = await time(1, () => runInit({ root, url: ADMIN_URL, schemas }));
  const catalog = (await import('node:fs')).readFileSync(join(root, '.tapu/catalog.json'), 'utf8');
  const cat = JSON.parse(catalog) as Catalog;

  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  const pgVersion = (await client.query('SHOW server_version')).rows[0].server_version as string;
  await client.end();

  console.log('# Tapu representation-size and latency report');
  console.log(`\nSizes are character counts; ≈tokens = characters / 4 (an estimate, not a tokenizer measurement).`);
  console.log(
    `Dataset: test/fixture.sql, schemas ${schemas.join(', ')}: ${cat.relations.length} relations, ` +
      `${cat.relations.reduce((n, r) => n + r.columns.length, 0)} columns, ${cat.enums.length} enums.`,
  );
  console.log(
    `Hardware: ${os.cpus()[0]?.model ?? 'unknown CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB RAM, ` +
      `${os.platform()} ${os.release()}; Node ${process.version}; PostgreSQL ${pgVersion} on the same machine.`,
  );

  // A. Raw information_schema metadata (evaluation-only baseline).
  const raw = await withSession(ADMIN_URL, async (s) => {
    const columns = await s.query(
      `SELECT * FROM information_schema.columns WHERE table_schema = ANY($1) ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );
    const constraints = await s.query(
      `SELECT * FROM information_schema.table_constraints WHERE table_schema = ANY($1) ORDER BY table_schema, table_name, constraint_name`,
      [schemas],
    );
    return unaligned(columns) + unaligned(constraints);
  });

  // B. A complete bounded discovery response.
  const overview = await payload<DiscoveryPayload>(root, {});
  const B = JSON.stringify(overview);
  console.log('\n## A and B (different information; the ratio is descriptive only)');
  console.log(`A. information_schema.columns + table_constraints (psql -A): ${size(raw)}`);
  console.log(`B. tapu explain overview, complete response incl. envelope:  ${size(B)} (${overview.overview!.length} relations)`);

  // C and D for one task: "change how orders store the customer email".
  const task = 'Change how orders keep the customer email (touches orders and customers)';
  const searchReq: ExplainRequest = { search: 'email' };
  const detailReq: ExplainRequest = { tables: ['orders', 'customers'], related: true };
  const enrichedReq: ExplainRequest = { ...detailReq, notes: true, rules: true };

  const search = await payload<DiscoveryPayload>(root, searchReq);
  const detailMeta = await payload<DetailPayload>(root, detailReq);
  console.log(`\n## C vs D for the task: ${task}`);
  console.log('Workflow: search for "email", then one batched detail call with direct FK neighbors.');

  const cMeta = printWorkflow('C, metadata only (right after init, no human notes)', [
    { label: '1', args: searchReq, response: search },
    { label: '2', args: detailReq, response: detailMeta },
  ]);
  const dMeta = baseline(cat, detailMeta, search, false);
  console.log(`\nD, metadata only: compact DDL for the same ${detailMeta.tables.length} relations + discovery listing: ${size(dMeta)}`);
  console.log('  (D excludes any tool definitions: they depend on the agent’s existing tools.)');
  console.log(`  C/D total ratio: ${(cMeta / dMeta.length).toFixed(2)}; C without tool definitions: ${((cMeta - JSON.stringify(TOOLS).length) / dMeta.length).toFixed(2)}`);

  await applyExampleNotes(root);
  const detailRich = await payload<DetailPayload>(root, enrichedReq);
  const cRich = printWorkflow('C, enriched (reviewed example notes and conventions requested)', [
    { label: '1', args: searchReq, response: search },
    { label: '2', args: enrichedReq, response: detailRich },
  ]);
  const dRich = baseline(cat, detailRich, search, true);
  console.log(`\nD, enriched: the same DDL plus the same prose: ${size(dRich)}`);
  console.log(`  C/D total ratio: ${(cRich / dRich.length).toFixed(2)}; C without tool definitions: ${((cRich - JSON.stringify(TOOLS).length) / dRich.length).toFixed(2)}`);

  console.log('\nFacts covered (C = Tapu, D = compact baseline):');
  const facts: [string, string, string][] = [
    ['relations, columns, types, nullability, defaults, identity, generated', 'yes', 'yes'],
    ['PK, unique, check, FK incl. actions and deferrability; constraint names', 'yes', 'yes'],
    ['non-constraint indexes incl. INCLUDE, predicates, validity', 'yes', 'yes'],
    ['view definitions, partition keys, referenced enum values', 'yes', 'yes'],
    ['referenced-by, sensitivity labels, row estimates, DB comments', 'yes', 'yes (SQL comments)'],
    ['external (uncaptured) FK targets marked', 'yes', 'yes (SQL comments)'],
    ['deterministic warnings (fk_without_index, undocumented, …)', 'yes', 'no'],
    ['snapshot source/revision, coverage, notice, context file paths', 'yes', 'no'],
    ['human prose (enriched scenario only)', 'yes', 'yes'],
  ];
  for (const [fact, c, d] of facts) console.log(`  - ${fact}: C ${c}, D ${d}`);
  console.log('These are representation sizes, not whole-task measurements; see eval/README.md.');

  console.log(`\n## Latency\ninit, first run on the fixture: ${initTime[0]!.toFixed(1)} ms`);
  await latency(root, `fixture (${cat.relations.length} relations)`, ['orders', 'customers'], 'email');

  if (BULK > 0) {
    await createBulkSchema(BULK);
    const bulkRoot = await mkdtemp(join(os.tmpdir(), 'tapu-token-compare-bulk-'));
    try {
      const t = await time(1, () => runInit({ root: bulkRoot, url: ADMIN_URL, schemas: ['public', 'bulk'] }));
      console.log(`\ninit, first run with ${BULK} generated tables: ${t[0]!.toFixed(1)} ms`);
      const bulkOverview = JSON.stringify((await explain(bulkRoot)).payload);
      console.log(`overview page (limit 50) with ${BULK + cat.relations.length} relations: ${size(bulkOverview)}`);
      await latency(bulkRoot, `fixture + ${BULK} generated tables`, ['orders', 'customers'], 'shared');
    } finally {
      await rm(bulkRoot, { recursive: true, force: true });
    }
  }
  console.log('\nLocal retrieval latency is not agent task duration; do not infer faster tasks from it.');
} finally {
  await rm(root, { recursive: true, force: true });
  await resetFixture();
}
