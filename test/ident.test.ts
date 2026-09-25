import { describe, expect, it } from 'vitest';
import { decodePageFileName, pageFileName, parseQualifiedName, qualifiedId, quoteIdent } from '../src/ident.js';

describe('identifiers', () => {
  it('quotes anything that is not a plain lower-case identifier', () => {
    expect(quoteIdent('orders')).toBe('orders');
    expect(quoteIdent('_x1')).toBe('_x1');
    expect(quoteIdent('Orders')).toBe('"Orders"');
    expect(quoteIdent('a.b')).toBe('"a.b"');
    expect(quoteIdent('1st')).toBe('"1st"');
    expect(quoteIdent('say "hi"')).toBe('"say ""hi"""');
    expect(quoteIdent('ünï')).toBe('"ünï"');
  });

  it('builds canonical IDs that keep dotted names apart', () => {
    expect(qualifiedId('public', 'orders')).toBe('public.orders');
    expect(qualifiedId('a.b', 'c')).toBe('"a.b".c');
    expect(qualifiedId('a', 'b.c')).toBe('a."b.c"');
    expect(qualifiedId('a.b', 'c')).not.toBe(qualifiedId('a', 'b.c'));
  });

  it('parses names like PostgreSQL, respecting quotes', () => {
    expect(parseQualifiedName('orders')).toEqual(['orders']);
    expect(parseQualifiedName('  Public.Orders ')).toEqual(['public', 'orders']);
    expect(parseQualifiedName('"Orders"')).toEqual(['Orders']);
    expect(parseQualifiedName('public."Orders"')).toEqual(['public', 'Orders']);
    expect(parseQualifiedName('"a.b".c')).toEqual(['a.b', 'c']);
    expect(parseQualifiedName('a."b.c"')).toEqual(['a', 'b.c']);
    expect(parseQualifiedName('"say ""hi"""')).toEqual(['say "hi"']);
    expect(parseQualifiedName('ÜBER')).toEqual(['Über']); // only ASCII letters fold
    for (const bad of ['', '.', 'a.', '.a', 'a..b', '"', '"a', '""', 'a.b.c', '"a"b', 'a"b"']) {
      expect(parseQualifiedName(bad), bad).toBeNull();
    }
  });

  it('round-trips canonical IDs through the parser', () => {
    for (const [schema, name] of [
      ['public', 'orders'],
      ['My Schema', 'Orders'],
      ['a.b', 'c"d'],
      ['ü', '/..'],
    ] as const) {
      expect(parseQualifiedName(qualifiedId(schema, name))).toEqual([schema, name]);
    }
  });
});

describe('page file names', () => {
  it('keeps simple names readable', () => {
    expect(pageFileName('public', 'orders')).toBe('public.orders.md');
    expect(pageFileName('billing', 'order_items-2')).toBe('billing.order_items-2.md');
  });

  it('encodes dots, slashes, case, spaces, percent and non-ASCII', () => {
    expect(pageFileName('public', 'Orders')).toBe('public.%4Frders.md');
    expect(pageFileName('a.b', 'c')).toBe('a%2Eb.c.md');
    expect(pageFileName('a', 'b.c')).toBe('a.b%2Ec.md');
    expect(pageFileName('public', '../../etc/passwd')).toBe('public.%2E%2E%2F%2E%2E%2Fetc%2Fpasswd.md');
    expect(pageFileName('public', '100%')).toBe('public.100%25.md');
    expect(pageFileName('public', 'ü')).toBe('public.%C3%BC.md');
    for (const file of [pageFileName('public', '../x'), pageFileName('..', '..')]) {
      expect(file).not.toContain('/');
      expect(file).toMatch(/^[A-Za-z0-9_.%-]+$/);
    }
  });

  it('never collides, even on a case-insensitive filesystem', () => {
    const names: [string, string][] = [
      ['public', 'orders'],
      ['public', 'Orders'],
      ['public', 'ORDERS'],
      ['Public', 'orders'],
      ['a.b', 'c'],
      ['a', 'b.c'],
      ['public', 'ä'],
      ['public', 'Ä'],
      ['public', '%C3%A4'],
      ['public', 'é'],
      ['public', 'é'],
    ];
    const files = names.map(([s, n]) => pageFileName(s, n).toLowerCase());
    expect(new Set(files).size).toBe(names.length);
  });

  it('decodes its own names and rejects everything else', () => {
    for (const [schema, name] of [
      ['public', 'orders'],
      ['public', 'Orders'],
      ['a.b', 'c.d'],
      ['ü', 'say "hi"/x'],
    ] as const) {
      expect(decodePageFileName(pageFileName(schema, name))).toEqual({ schema, name });
    }
    for (const other of ['README.md', 'notes.md', 'public.orders.txt', 'a.b.c.md', 'public.%zz.md', 'public.%4frders.md', '.md', 'x..md']) {
      expect(decodePageFileName(other), other).toBeNull();
    }
  });

  it('hashes very long names to stay within filesystem limits', () => {
    const name = 'ü'.repeat(63);
    const file = pageFileName('public', name);
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(200);
    expect(file).toMatch(/~[0-9a-f]{64}\.md$/);
    expect(pageFileName('public', name + 'x')).not.toBe(file);
    expect(decodePageFileName(file)).toBeNull();
  });
});
