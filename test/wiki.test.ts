import { describe, expect, it } from 'vitest';
import {
  AUTO_END,
  AUTO_START,
  LIFECYCLE_WARNING,
  archivePage,
  humanNotes,
  parsePage,
  renderContext,
  renderNewPage,
  updatePage,
} from '../src/wiki.js';
import { catalog, col, relation } from './factory.js';

const orders = relation('orders', { columns: [col('id'), col('customer_email')] });
const ctx = renderContext(catalog([orders]));
const page = renderNewPage(orders, ctx);

function parsed(text: string, id = orders.id) {
  const p = parsePage(text, id);
  if (!p.ok) throw new Error(p.reason);
  return p.page;
}

describe('page parsing', () => {
  it('reads a new page', () => {
    const p = parsed(page);
    expect(p.state).toBe('active');
    expect(p.hash).toBe(orders.hash);
    expect(p.docHash).toBe(orders.docHash);
    expect(p.front).toEqual({ purpose: '', owner: '', tags: [], columns: new Map() });
    expect(humanNotes(p, orders.id)).toBe('');
  });

  it('rejects missing, duplicated, misordered and malformed markers', () => {
    const cases: [string, string][] = [
      [page.replace(AUTO_END, ''), 'missing or duplicated'],
      [page.replace(AUTO_START + '\n', ''), 'missing or duplicated'],
      [page + `\n${AUTO_END}\n`, 'missing or duplicated'],
      [page + `\n${AUTO_START}\n`, 'missing or duplicated'],
      [page.replace(AUTO_START, 'x').replace(AUTO_END, AUTO_START).replace(/^x$/m, AUTO_END), 'out of order'],
      [page.replace(/<!-- tapu:hash [0-9a-f]+ -->/, '<!-- tapu:hash abc -->'), 'header'],
      [page.replace('<!-- tapu:state active -->', '<!-- tapu:state gone -->'), 'header'],
    ];
    for (const [text, reason] of cases) {
      const p = parsePage(text, orders.id);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(reason);
    }
  });

  it('rejects invalid frontmatter: YAML errors, duplicate keys, wrong types and identity', () => {
    const fm = (yaml: string) => page.replace(/^---\n[\s\S]*?\n---\n/, `---\n${yaml}\n---\n`);
    const base = 'tapu: 1\ntable: public.orders';
    const cases: [string, string][] = [
      [page.replace(/^---\n/, ''), 'missing frontmatter'],
      [fm(`${base}\npurpose: [unclosed`), 'not valid YAML'],
      [fm(`${base}\npurpose: a\npurpose: b`), 'duplicate keys'],
      [fm(`${base}\npurpose: 42`), '"purpose" must be a string'],
      [fm(`${base}\nowner: {a: 1}`), '"owner" must be a string'],
      [fm(`${base}\ntags: core`), '"tags" must be a list of strings'],
      [fm(`${base}\ntags: [1]`), '"tags" must be a list of strings'],
      [fm(`${base}\ncolumns: [a]`), '"columns" must be a mapping'],
      [fm(`${base}\ncolumns: {a: "note"}`), '"columns.a" must be a mapping'],
      [fm(`${base}\ncolumns: {a: {sensitive: "yes"}}`), 'must be true or false'],
      [fm(`${base}\ncolumns: {a: {note: 1}}`), '"columns.a.note" must be a string'],
      [fm('tapu: 2\ntable: public.orders'), '"tapu" must be 1'],
      [fm('tapu: 1\ntable: public.customers'), '"table" must be "public.orders"'],
      [fm('- a'), 'not a mapping'],
    ];
    for (const [text, reason] of cases) {
      const p = parsePage(text, orders.id);
      expect(p.ok, reason).toBe(false);
      if (!p.ok) expect(p.reason).toContain(reason);
    }
  });

  it('accepts unknown keys, comments, nulls and overrides', () => {
    const text = page.replace(
      /^---\n[\s\S]*?\n---\n/,
      '---\n# comment\ntapu: 1\ntable: public.orders\npurpose:\ncustom: {x: [1, 2]}\ncolumns:\n  customer_email:\n    note: snapshot\n    sensitive: false\n    reviewer: x\n  __proto__:\n---\n',
    );
    const p = parsed(text);
    expect(p.front.purpose).toBe('');
    expect([...p.front.columns]).toEqual([
      ['customer_email', { note: 'snapshot', sensitive: false }],
      ['__proto__', {}],
    ]);
  });
});

describe('page merging', () => {
  it('replaces only the bytes between the markers', () => {
    const edited = page
      .replace('purpose: ""', 'purpose:   "Purchases"   # keep spacing')
      .replace('# public.orders\n', '# public.orders\n\nIntro.\n')
      .replace('## Notes\n', '## Notes\n\n- keep me\n\ntrailing   ');
    const changed = relation('orders', { columns: [col('id'), col('customer_email'), col('note')] });
    const update = updatePage(edited, changed, renderContext(catalog([changed])));
    if (!update.ok) throw new Error(update.reason);
    const before = parsed(edited);
    const after = parsed(update.text);
    expect(update.text.slice(0, after.autoStart)).toBe(edited.slice(0, before.autoStart));
    expect(update.text.slice(after.autoEnd)).toBe(edited.slice(before.autoEnd));
    expect(after.hash).toBe(changed.hash);
    expect(humanNotes(after, orders.id)).toBe('Intro.\n\n## Why it exists\n\n\n## Notes\n\n- keep me\n\ntrailing');
  });

  it('archives without changing the retained description, idempotently', () => {
    const removed = archivePage(page, orders.id, 'removed');
    if (!removed.ok) throw new Error(removed.reason);
    const p = parsed(removed.text);
    expect(p.state).toBe('removed');
    expect(p.hash).toBe(orders.hash);
    expect(removed.text).toContain(LIFECYCLE_WARNING.removed);
    expect(removed.text.replace(LIFECYCLE_WARNING.removed + '\n\n', '').replace('state removed', 'state active')).toBe(page);

    const again = archivePage(removed.text, orders.id, 'removed');
    expect(again.ok && again.text).toBe(removed.text);

    const outOfScope = archivePage(removed.text, orders.id, 'out_of_scope');
    if (!outOfScope.ok) throw new Error(outOfScope.reason);
    expect(outOfScope.text).not.toContain(LIFECYCLE_WARNING.removed);
    expect(outOfScope.text.split(LIFECYCLE_WARNING.out_of_scope)).toHaveLength(2);

    const revived = updatePage(outOfScope.text, orders, ctx);
    expect(revived.ok && revived.text).toBe(page);
  });

  it('never lets metadata create marker lines', () => {
    const evil = relation('orders', {
      comment: `x\n${AUTO_END}\n${AUTO_START}`,
      kind: 'view',
      viewDefinition: `SELECT '\n${AUTO_END}\n<!-- tapu:state removed -->' AS x`,
      columns: [col('id', { comment: `\n${AUTO_START}\n` })],
    });
    const text = renderNewPage(evil, renderContext(catalog([evil])));
    expect(parsePage(text, evil.id).ok).toBe(true);
    const markerLines = text.split('\n').filter((l) => l.startsWith('<!--'));
    expect(markerLines).toEqual([AUTO_START, '<!-- tapu:state active -->', `<!-- tapu:hash ${evil.hash} -->`, `<!-- tapu:doc-hash ${evil.docHash} -->`, AUTO_END]);
  });

  it('writes quoted identities that validate', () => {
    const odd = relation('Odd "name".x', { schema: 'My Schema' });
    const text = renderNewPage(odd, renderContext(catalog([odd], [], ['My Schema'])));
    expect(text).toContain(`table: ${JSON.stringify(odd.id)}\n`);
    expect(parsePage(text, odd.id).ok).toBe(true);
  });
});
