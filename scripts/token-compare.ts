/**
 * Seed of the public benchmark: approximate tokens an agent reads to learn the
 * fixture schema (a) from a raw information_schema dump vs. (b) from
 * `tapu explain`. Tokens are estimated as characters / 4.
 *
 * Usage: npm run token-compare [-- --schemas public,billing]
 * Loads test/fixture.sql into $TAPU_TEST_DATABASE_URL (the disposable test database).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { withSession } from '../src/db.js';
import { explain } from '../src/explain.js';
import { runInit } from '../src/init.js';

const url = process.env.TAPU_TEST_DATABASE_URL ?? 'postgres://tapu:tapu@localhost:54329/tapu_test';
const schemasArg = process.argv.indexOf('--schemas');
const schemas = schemasArg > 0 ? process.argv[schemasArg + 1]!.split(',') : ['public'];

const tokens = (text: string) => Math.round(text.length / 4);

/** Rows as `psql -A` prints them: a header line, then one `|`-separated line per row. */
function unaligned(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return [cols.join('|'), ...rows.map((r) => cols.map((c) => cell(r[c])).join('|'))].join('\n') + '\n';
}

async function loadFixture(): Promise<void> {
  const fixture = await readFile(new URL('../../test/fixture.sql', import.meta.url), 'utf8');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS billing CASCADE; DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC; ${fixture}`);
  } finally {
    await client.end();
  }
}

await loadFixture();

const raw = await withSession(url, async (s) => {
  const columns = await s.query(
    `SELECT * FROM information_schema.columns WHERE table_schema = ANY($1)
     ORDER BY table_schema, table_name, ordinal_position`,
    [schemas],
  );
  const constraints = await s.query(
    `SELECT * FROM information_schema.table_constraints WHERE table_schema = ANY($1)
     ORDER BY table_schema, table_name, constraint_name`,
    [schemas],
  );
  return unaligned(columns) + unaligned(constraints);
});

const root = await mkdtemp(join(tmpdir(), 'tapu-token-compare-'));
try {
  await runInit({ root, url, schemas });
  const overview = JSON.stringify(await explain(root));
  const ids = (JSON.parse(overview) as { overview: { t: string }[] }).overview.map((e) => e.t);
  const relations = ids.length;
  // Not required by the spec, but keeps the comparison honest: full entries carry what the raw dump carries.
  const full = JSON.stringify(await explain(root, { tables: ids }));
  const rawTokens = tokens(raw);
  const tapuTokens = tokens(overview);
  console.log(`Fixture schemas: ${schemas.join(', ')} (${relations} relations)`);
  console.log(`(a) information_schema.columns + table_constraints (psql -A): ~${rawTokens} tokens (${raw.length} chars)`);
  console.log(`(b) tapu explain overview: ~${tapuTokens} tokens (${overview.length} chars, ~${(tapuTokens / relations).toFixed(1)}/relation)`);
  console.log(`(c) tapu explain <every relation>, full entries: ~${tokens(full)} tokens (${full.length} chars)`);
  console.log(`Overview is ${(rawTokens / tapuTokens).toFixed(1)}x smaller than (a); full entries ${(rawTokens / tokens(full)).toFixed(1)}x.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
