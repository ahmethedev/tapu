import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { formatStatusHuman, runStatus, statusExitCode, type StatusReport } from '../src/status.js';
import { AUTO_END } from '../src/wiki.js';
import { ADMIN_URL, adminSql, pagePath, resetFixture, runCli, setFrontmatter, tempRoot } from './helpers.js';

const codes = (r: StatusReport) => r.findings.map((f) => `${f.code}${'t' in f ? ` ${f.t}` : ''}`);

describe('tapu status', () => {
  let root: string;
  const init = (schemas?: string[]) => runInit({ root, url: ADMIN_URL, schemas });
  const status = () => runStatus(root, ADMIN_URL);

  beforeEach(async () => {
    await resetFixture();
    root = await tempRoot();
    await init();
  });

  it('is synchronized right after init, with advisories and coverage', async () => {
    const report = await status();
    expect(report).toMatchObject({ result: 'synchronized', schemas: ['public'], coverage: 'tapu-pg-v1', findings: [], errors: [], archived: [] });
    expect(report.notCovered).toContain('triggers');
    expect(report.advisories).toContainEqual({ code: 'fk_without_index', t: 'public.orders', columns: ['customer_id'] });
    expect(report.advisories).toContainEqual({ code: 'no_primary_key', t: 'public.audit_events' });
    expect(report.snapshot.revision).toBe(report.live.revision);
  });

  it('exits 1 after an added column and 0 after init (CLI)', async () => {
    const env = { TAPU_DATABASE_URL: ADMIN_URL };
    expect((await runCli(['status'], root, env)).code).toBe(0);

    await adminSql('ALTER TABLE public.orders ADD COLUMN note text');
    const drift = await runCli(['status'], root, env);
    expect(drift.code).toBe(1);
    const report = JSON.parse(drift.stdout) as StatusReport;
    expect(report.result).toBe('out_of_sync');
    expect(report.findings).toEqual([
      { code: 'relation_changed', t: 'public.orders', sections: ['columns'] },
      { code: 'page_structure_mismatch', t: 'public.orders', file: 'db-wiki/tables/public.orders.md' },
    ]);
    const human = await runCli(['status', '--human'], root, env);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('relation_changed public.orders sections=columns');

    await init();
    const after = await runCli(['status'], root, env);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout).result).toBe('synchronized');
  });

  it('treats a dropped relation as drift until init archives it', async () => {
    await adminSql('CREATE TABLE public.coupons (code text PRIMARY KEY); DROP TABLE public.returns;');
    const report = await status();
    expect(codes(report)).toEqual([
      'relation_added public.coupons',
      'relation_removed public.returns',
      'page_missing public.coupons',
      'page_not_archived public.returns',
    ]);
    expect(statusExitCode(report)).toBe(1);

    await init();
    const after = await status();
    expect(after.result).toBe('synchronized');
    expect(after.archived).toEqual([{ t: 'public.returns', state: 'removed', file: 'db-wiki/tables/public.returns.md' }]);
    await rm(pagePath(root, 'public.returns.md'));
    expect((await status()).archived).toEqual([]);
  });

  it('distinguishes scope exclusion from removal', async () => {
    await init(['public', 'billing']);
    await init(['public']);
    const report = await status();
    expect(report.result).toBe('synchronized');
    expect(report.archived).toEqual([{ t: 'billing.invoices', state: 'out_of_scope', file: 'db-wiki/tables/billing.invoices.md' }]);
  });

  it('reports a changed view query even when its column types stay the same', async () => {
    await adminSql(`CREATE OR REPLACE VIEW public.order_totals AS
      SELECT o.id AS order_id, sum(i.quantity * i.unit_price_cents * 2) AS total_cents
      FROM public.orders o JOIN public.order_items i ON i.order_id = o.id GROUP BY o.id`);
    const report = await status();
    expect(report.findings).toContainEqual({ code: 'relation_changed', t: 'public.order_totals', sections: ['view'] });
  });

  it('reports enum changes, including unused enums, and their effect on referencing relations', async () => {
    await adminSql(`ALTER TYPE public.order_status ADD VALUE 'refunded'; ALTER TYPE public.legacy_region ADD VALUE 'east';`);
    await adminSql(`CREATE TYPE public.new_kind AS ENUM ('a'); DROP TYPE public.contact_channel CASCADE;`);
    const report = await status();
    const found = codes(report);
    expect(found).toContain('enum_changed public.order_status');
    expect(found).toContain('enum_changed public.legacy_region');
    expect(found).toContain('enum_added public.new_kind');
    expect(found).toContain('enum_removed public.contact_channel');
    expect(report.findings).toContainEqual({ code: 'relation_changed', t: 'public.orders', sections: ['enums'] });
    expect(report.findings).toContainEqual({ code: 'relation_changed', t: 'public.customers', sections: ['columns', 'enums'] });
  });

  it('reports DB comment changes as documentation changes only', async () => {
    await adminSql(`COMMENT ON TABLE public.products IS 'Things we sell'; COMMENT ON COLUMN public.orders.status IS 'Lifecycle';`);
    const report = await status();
    expect(report.findings).toEqual([
      { code: 'relation_documentation_changed', t: 'public.orders', columns: ['status'] },
      { code: 'relation_documentation_changed', t: 'public.products', table: true },
      { code: 'page_documentation_mismatch', t: 'public.orders', file: 'db-wiki/tables/public.orders.md' },
      { code: 'page_documentation_mismatch', t: 'public.products', file: 'db-wiki/tables/public.products.md' },
    ]);
    expect(report.findings.some((f) => f.code === 'relation_changed' || f.code === 'page_structure_mismatch')).toBe(false);
  });

  it('ignores row-estimate-only changes', async () => {
    await adminSql(`INSERT INTO public.products (sku, name, price_cents) SELECT 'sku-' || g, 'p', 1 FROM generate_series(1, 50) g; ANALYZE public.products;`);
    const report = await status();
    expect(report.result).toBe('synchronized');
    await init();
    const catalog = JSON.parse(await readFile(join(root, '.tapu/catalog.json'), 'utf8'));
    expect(catalog.relations.find((r: { id: string }) => r.id === 'public.products').rows).toBe(50);
    expect((await status()).result).toBe('synchronized');
  });

  it('checks page hashes against live metadata even when the catalog looks current', async () => {
    const file = pagePath(root, 'public.products.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/tapu:hash [0-9a-f]+/, `tapu:hash ${'0'.repeat(64)}`));
    const report = await status();
    expect(report.findings).toEqual([{ code: 'page_structure_mismatch', t: 'public.products', file: 'db-wiki/tables/public.products.md' }]);
    expect(statusExitCode(report)).toBe(1);
  });

  it('reports stale column notes until a person resolves them', async () => {
    await setFrontmatter(root, 'public.customers.md', 'tapu: 1\ntable: public.customers\ncolumns:\n  fax: { note: "gone" }\n  "evil\\a": {}');
    let report = await status();
    expect(report.findings).toEqual([
      { code: 'stale_note', t: 'public.customers', column: 'fax', file: 'db-wiki/tables/public.customers.md' },
      { code: 'stale_note', t: 'public.customers', column: 'evil', file: 'db-wiki/tables/public.customers.md' },
    ]);
    await init();
    report = await status();
    expect(report.result).toBe('out_of_sync');
    expect(formatStatusHuman(report)).toContain('stale_note public.customers column=fax');
  });

  it('exits 2 for malformed pages but still reports all findings', async () => {
    const orders = pagePath(root, 'public.orders.md');
    await writeFile(orders, (await readFile(orders, 'utf8')).replace(AUTO_END, ''));
    await adminSql('ALTER TABLE public.products ADD COLUMN weight int');
    const result = await runCli(['status'], root, { TAPU_DATABASE_URL: ADMIN_URL });
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as StatusReport;
    expect(report.result).toBe('error');
    expect(report.errors).toEqual([
      { code: 'page_invalid', t: 'public.orders', file: 'db-wiki/tables/public.orders.md', reason: 'tapu:auto markers are missing or duplicated' },
    ]);
    expect(codes(report)).toContain('relation_changed public.products');
  });

  it('reports missing artifacts and scope changes', async () => {
    await rm(join(root, 'db-wiki/index.md'));
    await rm(join(root, 'db-wiki/rules.md'));
    await writeFile(join(root, '.tapu/config.json'), '{"version":1,"schemas":["public","billing"],"wikiDir":"db-wiki"}');
    const report = await status();
    expect(report.findings).toContainEqual({ code: 'scope_changed', configured: ['public', 'billing'], snapshot: ['public'] });
    expect(report.findings).toContainEqual({ code: 'index_missing', file: 'db-wiki/index.md' });
    expect(report.findings).toContainEqual({ code: 'relation_added', t: 'billing.invoices' });
    expect(report.advisories).toContainEqual({ code: 'rules_missing', file: 'db-wiki/rules.md' });
  });

  it('exits 2 on operational errors with a structured error', async () => {
    const noUrl = await runCli(['status'], root);
    expect(noUrl.code).toBe(2);
    expect(JSON.parse(noUrl.stdout).error.code).toBe('no_database_url');

    const noInit = await runCli(['status'], await tempRoot(), { TAPU_DATABASE_URL: ADMIN_URL });
    expect(noInit.code).toBe(2);
    expect(JSON.parse(noInit.stdout).error).toMatchObject({ code: 'not_initialized', details: { next: 'tapu init' } });

    await writeFile(join(root, '.tapu/catalog.json'), '{"format": 2}');
    const invalid = await runCli(['status'], root, { TAPU_DATABASE_URL: ADMIN_URL });
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout).error.code).toBe('invalid_catalog');

    const badFlag = await runCli(['status', '--bogus'], root, { TAPU_DATABASE_URL: ADMIN_URL });
    expect(badFlag.code).toBe(2);
  });
});
