import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { formatStatusHuman, runStatus } from '../src/status.js';
import { AUTO_END } from '../src/wiki.js';
import { ADMIN_URL, adminSql, resetFixture, runCli, tempRoot } from './helpers.js';

describe('tapu status', () => {
  let root: string;

  beforeEach(async () => {
    await resetFixture();
    root = await tempRoot();
    await runInit({ root, url: ADMIN_URL });
  });

  it('exits 1 after ALTER TABLE and reports public.orders changed; exits 0 after init (CLI)', async () => {
    const env = { TAPU_DATABASE_URL: ADMIN_URL };
    const clean = await runCli(['status'], root, env);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout).clean).toBe(true);

    await adminSql('ALTER TABLE orders ADD COLUMN note text');
    const drift = await runCli(['status'], root, env);
    expect(drift.code).toBe(1);
    const report = JSON.parse(drift.stdout);
    expect(report).toMatchObject({ clean: false, changed: ['public.orders'], added: [], removed: [] });

    const human = await runCli(['status', '--human'], root, env);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('changed relations: public.orders');

    await runInit({ root, url: ADMIN_URL });
    const after = await runCli(['status'], root, env);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout).clean).toBe(true);
  });

  it('reports added and removed relations and pages', async () => {
    await adminSql('CREATE TABLE public.coupons (code text PRIMARY KEY); DROP TABLE public.returns;');
    const report = await runStatus(root, ADMIN_URL);
    expect(report).toMatchObject({
      clean: false,
      added: ['public.coupons'],
      removed: ['public.returns'],
      changed: [],
      pages: { missing: ['public.coupons'], removed: ['public.returns'], broken: [] },
    });

    // After init the removed page is kept (humans delete it), so status still reports it.
    await runInit({ root, url: ADMIN_URL });
    const after = await runStatus(root, ADMIN_URL);
    expect(after).toMatchObject({ clean: false, added: [], removed: [], pages: { removed: ['public.returns'] } });
    await rm(join(root, 'db-wiki/tables/public.returns.md'));
    expect((await runStatus(root, ADMIN_URL)).clean).toBe(true);
  });

  it('compares pages with the live database without trusting the catalog alone', async () => {
    const file = join(root, 'db-wiki/tables/public.products.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/tapu:hash [0-9a-f]+/, 'tapu:hash 0123456789abcdef'));
    expect((await runStatus(root, ADMIN_URL)).changed).toEqual(['public.products']);
  });

  it('reports broken pages and stale column notes', async () => {
    const orders = join(root, 'db-wiki/tables/public.orders.md');
    await writeFile(orders, (await readFile(orders, 'utf8')).replace(AUTO_END, ''));
    const customers = join(root, 'db-wiki/tables/public.customers.md');
    await writeFile(
      customers,
      (await readFile(customers, 'utf8')).replace(/^columns:.*$/m, 'columns:\n  fax: { note: "gone" }'),
    );
    const report = await runStatus(root, ADMIN_URL);
    expect(report.pages.broken).toEqual([
      { file: 'db-wiki/tables/public.orders.md', reason: 'tapu:auto markers are missing or duplicated' },
    ]);
    expect(report.staleNotes).toEqual([{ t: 'public.customers', col: 'fax' }]);
    expect(formatStatusHuman(report)).toContain('stale column notes: public.customers.fax');
  });

  it('exits 2 on errors', async () => {
    const noUrl = await runCli(['status'], root);
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toContain('No database URL');

    const noInit = await runCli(['status'], await tempRoot(), { TAPU_DATABASE_URL: ADMIN_URL });
    expect(noInit.code).toBe(2);
    expect(noInit.stderr).toContain('Run `tapu init` first');

    const badFlag = await runCli(['status', '--bogus'], root, { TAPU_DATABASE_URL: ADMIN_URL });
    expect(badFlag.code).toBe(2);
  });
});
