import { describe, expect, it } from 'vitest';
import { fkHasIndex, relationWarnings, staleNotes } from '../src/warnings.js';
import { catalog, col, enumType, fk, index, relation } from './factory.js';

describe('hashes', () => {
  const status = enumType('public', 'status', ['a', 'b']);

  it('are full SHA-256 values; the structural hash ignores comments and row estimates', () => {
    const base = relation('t', { columns: [col('id'), col('s', { enumType: status.id })] }, [status]);
    expect(base.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(base.docHash).toMatch(/^[0-9a-f]{64}$/);

    const commented = relation('t', { comment: 'x', columns: [col('id', { comment: 'y' }), col('s', { enumType: status.id })] }, [status]);
    expect(commented.hash).toBe(base.hash);
    expect(commented.docHash).not.toBe(base.docHash);

    const counted = relation('t', { rows: 123, columns: base.columns }, [status]);
    expect(counted.hash).toBe(base.hash);
    expect(counted.docHash).toBe(base.docHash);
  });

  it('change with enum values, view definitions, partition keys and index details', () => {
    const cols = [col('s', { enumType: status.id })];
    const a = relation('t', { columns: cols }, [status]);
    const b = relation('t', { columns: cols }, [enumType('public', 'status', ['a', 'b', 'c'])]);
    expect(b.hash).not.toBe(a.hash);

    const v1 = relation('v', { kind: 'view', viewDefinition: 'SELECT 1 AS x' });
    const v2 = relation('v', { kind: 'view', viewDefinition: 'SELECT 2 AS x' });
    expect(v2.hash).not.toBe(v1.hash);

    const p1 = relation('p', { kind: 'partitioned_table', partitionKey: 'RANGE (a)' });
    const p2 = relation('p', { kind: 'partitioned_table', partitionKey: 'LIST (a)' });
    expect(p2.hash).not.toBe(p1.hash);

    const i1 = relation('i', { indexes: [index('x', ['id'])] });
    const i2 = relation('i', { indexes: [index('x', ['id'], { valid: false })] });
    const i3 = relation('i', { indexes: [index('x', ['id'], { predicate: '(id > 0)' })] });
    expect(new Set([i1.hash, i2.hash, i3.hash]).size).toBe(3);
  });

  it('give a revision that ignores generatedAt and row estimates', () => {
    const a = catalog([relation('t')]);
    const b = { ...catalog([relation('t', { rows: 99 })]), generatedAt: '2030-01-01T00:00:00.000Z' };
    expect(b.revision).toBe(a.revision);
    expect(catalog([relation('t', { comment: 'c' })]).revision).not.toBe(a.revision);
    expect(catalog([relation('t')], [], ['public', 'billing']).revision).not.toBe(a.revision);
  });
});

describe('fk_without_index', () => {
  const rel = (indexes: ReturnType<typeof index>[], fks = [fk(['a', 'b'])]) =>
    relation('child', { columns: [col('a'), col('b'), col('c')], foreignKeys: fks, indexes });
  const covered = (indexes: ReturnType<typeof index>[]) => fkHasIndex(rel(indexes), fk(['a', 'b']));

  it('counts valid, non-partial B-tree indexes whose leading plain columns are the FK columns in any order', () => {
    expect(covered([index('i', ['a', 'b'])])).toBe(true);
    expect(covered([index('i', ['b', 'a'])])).toBe(true);
    expect(covered([index('i', ['b', 'a', 'c'])])).toBe(true);
    expect(covered([index('i', ['a', 'b', { expression: 'lower(c)' }])])).toBe(true);
  });

  it('ignores other shapes', () => {
    expect(covered([])).toBe(false);
    expect(covered([index('i', ['a'])])).toBe(false);
    expect(covered([index('i', ['c', 'a', 'b'])])).toBe(false);
    expect(covered([index('i', ['a'], { include: ['b'] })])).toBe(false);
    expect(covered([index('i', ['a', { expression: 'b' }])])).toBe(false);
    expect(covered([index('i', ['a', 'b'], { predicate: '(a IS NOT NULL)' })])).toBe(false);
    expect(covered([index('i', ['a', 'b'], { valid: false })])).toBe(false);
    expect(covered([index('i', ['a', 'b'], { method: 'hash' })])).toBe(false);
    expect(covered([index('i', ['a', 'a'])])).toBe(false);
  });

  it('warns once per uncovered column list, with structured details', () => {
    const r = rel([], [fk(['a', 'b']), fk(['a', 'b'], 'public.other'), fk(['c'])]);
    expect(relationWarnings(r, null).filter((w) => w.code === 'fk_without_index')).toEqual([
      { code: 'fk_without_index', columns: ['a', 'b'] },
      { code: 'fk_without_index', columns: ['c'] },
    ]);
  });
});

describe('other warnings', () => {
  const front = (purpose: string, columns: string[] = []) => ({
    purpose,
    owner: '',
    tags: [],
    columns: new Map(columns.map((c) => [c, { note: 'n' }])),
  });

  it('no_primary_key applies to tables only', () => {
    expect(relationWarnings(relation('t'), front('p'))).toEqual([{ code: 'no_primary_key' }]);
    expect(relationWarnings(relation('v', { kind: 'view' }), front('p'))).toEqual([]);
    expect(relationWarnings(relation('p', { kind: 'partitioned_table' }), front('p'))).toEqual([{ code: 'no_primary_key' }]);
  });

  it('undocumented needs both an empty purpose and an empty DB comment', () => {
    const v = (r: ReturnType<typeof relation>, f: ReturnType<typeof front> | null) =>
      relationWarnings(r, f).some((w) => w.code === 'undocumented');
    expect(v(relation('v', { kind: 'view' }), null)).toBe(true);
    expect(v(relation('v', { kind: 'view' }), front('  '))).toBe(true);
    expect(v(relation('v', { kind: 'view' }), front('why'))).toBe(false);
    expect(v(relation('v', { kind: 'view', comment: 'c' }), null)).toBe(false);
  });

  it('stale_note lists frontmatter columns that no longer exist', () => {
    const r = relation('v', { kind: 'view', columns: [col('a')] });
    expect(staleNotes(r, front('p', ['a', 'gone', '__proto__']))).toEqual(['gone', '__proto__']);
  });
});
