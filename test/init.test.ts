import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { AGENTS_LINE, AUTO_END, AUTO_START, REMOVED_WARNING, parsePage } from '../src/wiki.js';
import { ADMIN_URL, adminSql, resetFixture, tempRoot } from './helpers.js';

const FIXTURE_PAGES = [
  'public.audit_events.md',
  'public.customers.md',
  'public.daily_sales.md',
  'public.order_items.md',
  'public.order_totals.md',
  'public.orders.md',
  'public.page_views.md',
  'public.products.md',
  'public.returns.md',
];

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const f of await listFiles(root)) files.set(f, await readFile(join(root, f), 'utf8'));
  return files;
}

const read = (root: string, f: string) => readFile(join(root, f), 'utf8');
const init = (root: string, extra: Partial<Parameters<typeof runInit>[0]> = {}) =>
  runInit({ root, url: ADMIN_URL, ...extra });

describe('tapu init', () => {
  let root: string;

  beforeEach(async () => {
    await resetFixture();
    root = await tempRoot();
  });

  it('creates the expected files', async () => {
    const result = await init(root, { now: new Date('2026-09-25T10:30:00.123Z') });
    expect(await listFiles(root)).toEqual([
      '.tapu/catalog.json',
      '.tapu/config.json',
      'db-wiki/index.md',
      'db-wiki/log.md',
      'db-wiki/rules.md',
      ...FIXTURE_PAGES.map((p) => `db-wiki/tables/${p}`),
    ]);
    expect(JSON.parse(await read(root, '.tapu/config.json'))).toEqual({
      version: 1,
      schemas: ['public'],
      wikiDir: 'db-wiki',
    });
    expect(result.added).toHaveLength(9);
    expect(await read(root, 'db-wiki/log.md')).toContain(
      '2026-09-25T10:30:00Z init: 9 tables, 9 new, 0 changed, 0 removed\n',
    );

    const index = await read(root, 'db-wiki/index.md');
    expect(index).toContain('- [public.orders](tables/public.orders.md) — _undocumented_');
    expect(index).toContain('- [public.customers](tables/public.customers.md) — Registered shop customers');

    const orders = await read(root, 'db-wiki/tables/public.orders.md');
    expect(orders.startsWith('---\ntapu: 1\ntable: public.orders\n')).toBe(true);
    expect(orders).toContain(AUTO_START);
    expect(orders).toMatch(/<!-- tapu:hash [0-9a-f]{16} -->/);
    expect(orders).toContain('| status | public.order_status (pending, paid, shipped, cancelled) | no |');
    expect(orders).toContain('- customer_id → [public.customers](public.customers.md) (id), on delete no action');
    expect(orders).toContain('- [public.order_items](public.order_items.md) (order_id) — order_items_order_id_fkey');
    expect(orders).toContain('- fk_without_index: customer_id');
    expect(orders).toContain('| shipping_address | text | yes |  | SENSITIVE |  |');
    expect(orders).toContain('## Why it exists');

    const audit = await read(root, 'db-wiki/tables/public.audit_events.md');
    expect(audit).toContain('- no_primary_key');
    expect(audit).not.toContain('\u0007');
  });

  it('is idempotent: a second run changes nothing but generatedAt and the log', async () => {
    await init(root, { now: new Date('2026-09-25T10:30:00Z') });
    const first = await snapshot(root);
    const result = await init(root, { now: new Date('2026-09-25T11:00:00Z') });
    const second = await snapshot(root);

    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [file, text] of second) {
      if (file === '.tapu/catalog.json') {
        const a = JSON.parse(first.get(file)!);
        const b = JSON.parse(text);
        expect(b.generatedAt).not.toBe(a.generatedAt);
        expect({ ...b, generatedAt: '' }).toEqual({ ...a, generatedAt: '' });
        expect(text.replace(/"generatedAt": ".*"/, '')).toBe(first.get(file)!.replace(/"generatedAt": ".*"/, ''));
      } else if (file === 'db-wiki/log.md') {
        expect(text).toBe(first.get(file)! + '2026-09-25T11:00:00Z init: 9 tables, 0 new, 0 changed, 0 removed\n');
      } else {
        expect(text, file).toBe(first.get(file));
      }
    }
    expect(result.wiki.updated).toEqual([]);
  });

  it('preserves human edits to frontmatter and body byte for byte', async () => {
    await init(root);
    const file = join(root, 'db-wiki/tables/public.customers.md');
    const original = await readFile(file, 'utf8');
    const edited = original
      .replace(
        /^---\n[\s\S]*?\n---\n/,
        [
          '---',
          '# Owned by the growth team',
          'owner:   "growth@example.com"   # keep this spacing',
          'tapu: 1',
          'purpose: Everyone who has ever signed up',
          'table: public.customers',
          'tags: [pii, core]',
          'columns:',
          '  email:',
          '    note: "Login identifier; unique"',
          '  emailed_at:',
          '    sensitive: true',
          '  phone: { sensitive: false }',
          '  fax: { note: "dropped in 2024" }',
          'custom_key: {a: 1}',
          '---',
          '',
        ].join('\n'),
      )
      .replace('# public.customers\n', '# public.customers\n\nIntro written by a human.\n')
      .replace('## Notes\n', '## Notes\n\n- 2026-03: decided to keep soft-deleted customers.\n\nTrailing text   \n');
    await writeFile(file, edited);

    await init(root);
    const after = await readFile(file, 'utf8');
    const a = parsePage(edited);
    const b = parsePage(after);
    if (!a.ok || !b.ok) throw new Error('page did not parse');
    expect(after.slice(0, b.page.autoStart)).toBe(edited.slice(0, a.page.autoStart));
    expect(after.slice(b.page.autoEnd)).toBe(edited.slice(a.page.autoEnd));

    // The auto block honours the human overrides.
    expect(after).toContain('| emailed_at | timestamp with time zone | yes |  | SENSITIVE |  |');
    expect(after).toContain('| phone | text | yes |  |  |  |');
    expect(after).toContain('- stale_note: fax');
    expect(after).not.toContain('- undocumented');

    // And a further run is a no-op.
    await init(root);
    expect(await readFile(file, 'utf8')).toBe(after);
    expect(await read(root, 'db-wiki/index.md')).toContain(
      '- [public.customers](tables/public.customers.md) — Everyone who has ever signed up',
    );
  });

  it('marks pages of dropped relations as removed instead of deleting them', async () => {
    await init(root);
    const file = join(root, 'db-wiki/tables/public.returns.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('## Notes\n', '## Notes\n\nKeep me.\n'));
    const before = await readFile(file, 'utf8');

    await adminSql('DROP TABLE public.returns');
    const result = await init(root);
    expect(result.removed).toEqual(['public.returns']);
    expect(result.wiki.markedRemoved).toEqual(['public.returns']);

    const after = await readFile(file, 'utf8');
    const parsed = parsePage(after);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.page.front.status).toBe('removed');
    expect(after.slice(parsed.page.autoStart).startsWith(REMOVED_WARNING)).toBe(true);
    // Only the status line and the warning were added.
    expect(after.replace('status: removed\n', '').replace(REMOVED_WARNING + '\n\n', '')).toBe(before);
    expect(await read(root, 'db-wiki/log.md')).toMatch(/init: 8 tables, 0 new, 0 changed, 1 removed\n$/);

    // Idempotent while the relation stays gone.
    await init(root);
    expect(await readFile(file, 'utf8')).toBe(after);
    expect(await read(root, 'db-wiki/index.md')).not.toContain('public.returns');

    // If the relation comes back, the page is live again.
    await resetFixture();
    await init(root);
    const revived = parsePage(await readFile(file, 'utf8'));
    if (!revived.ok) throw new Error(revived.reason);
    expect(revived.page.front.status).toBeNull();
    expect(await readFile(file, 'utf8')).not.toContain(REMOVED_WARNING);
    expect(await readFile(file, 'utf8')).toContain('Keep me.');
  });

  it('skips and reports pages with missing or malformed markers', async () => {
    await init(root);
    const broken = {
      'public.orders.md': (t: string) => t.replace(AUTO_END, ''),
      'public.products.md': (t: string) => t + `\n${AUTO_END}\n`,
      'public.returns.md': (t: string) => t.replace(/^---\n/, ''),
    };
    const contents = new Map<string, string>();
    for (const [name, breakIt] of Object.entries(broken)) {
      const file = join(root, 'db-wiki/tables', name);
      const text = breakIt(await readFile(file, 'utf8'));
      await writeFile(file, text);
      contents.set(name, text);
    }
    await adminSql('ALTER TABLE public.orders ADD COLUMN note text');

    const result = await init(root);
    expect(result.wiki.skipped.map((s) => s.file)).toEqual([
      'db-wiki/tables/public.orders.md',
      'db-wiki/tables/public.products.md',
      'db-wiki/tables/public.returns.md',
    ]);
    for (const [name, text] of contents) {
      expect(await readFile(join(root, 'db-wiki/tables', name), 'utf8')).toBe(text);
    }
  });

  it('never lets database comments forge markers', async () => {
    await adminSql(`COMMENT ON TABLE public.orders IS '${AUTO_END} <!-- tapu:auto:start -->'`);
    await adminSql(`COMMENT ON COLUMN public.orders.status IS 'a | b\nsecond line'`);
    await init(root);
    const text = await read(root, 'db-wiki/tables/public.orders.md');
    expect(parsePage(text).ok).toBe(true);
    expect(text).toContain('**Comment:** &lt;!-- tapu:auto:end --> &lt;!-- tapu:auto:start -->');
    expect(text).toContain('a \\| b second line');
    const again = await init(root);
    expect(again.wiki.skipped).toEqual([]);
  });

  it('creates rules.md once and never overwrites it', async () => {
    await init(root);
    await writeFile(join(root, 'db-wiki/rules.md'), 'Our rules.\n');
    await init(root);
    expect(await read(root, 'db-wiki/rules.md')).toBe('Our rules.\n');
    await rm(join(root, 'db-wiki/rules.md'));
    await init(root);
    expect(await read(root, 'db-wiki/rules.md')).toContain('# Database rules');
  });

  it('appends the AGENTS.md line once with --write-agents', async () => {
    const first = await init(root);
    expect(first.agents).toBe('skipped');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).rejects.toThrow();

    await writeFile(join(root, 'AGENTS.md'), '# Agents\nBe nice.');
    expect((await init(root, { writeAgents: true })).agents).toBe('written');
    expect((await init(root, { writeAgents: true })).agents).toBe('present');
    expect(await read(root, 'AGENTS.md')).toBe(`# Agents\nBe nice.\n${AGENTS_LINE}\n`);
  });

  it('documents a second schema only when configured, and remembers the choice', async () => {
    await init(root, { schemas: ['public', 'billing'] });
    expect(JSON.parse(await read(root, '.tapu/config.json')).schemas).toEqual(['public', 'billing']);
    expect(await read(root, 'db-wiki/tables/billing.invoices.md')).toContain('| iban | text | yes |  | SENSITIVE |  |');
    const again = await init(root);
    expect(again.config.schemas).toEqual(['public', 'billing']);
    expect(again.added).toEqual([]);
  });
});
