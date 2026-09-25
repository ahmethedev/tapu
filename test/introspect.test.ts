import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog, Relation } from '../src/catalog.js';
import { withSession } from '../src/db.js';
import { introspect } from '../src/introspect.js';
import { ADMIN_URL, adminSql, resetFixture } from './helpers.js';

async function load(schemas: string[]): Promise<Catalog> {
  return withSession(ADMIN_URL, (s) => introspect(s, schemas, new Date('2026-09-25T10:30:00Z')));
}

function rel(catalog: Catalog, id: string): Relation {
  const r = catalog.relations.find((x) => x.id === id);
  if (!r) throw new Error(`missing ${id}`);
  return r;
}

describe('introspect', () => {
  let catalog: Catalog;

  beforeAll(async () => {
    await resetFixture();
    catalog = await load(['public']);
  });

  it('captures tables, the partitioned parent, views and materialized views, but not partitions', () => {
    expect(catalog.relations.map((r) => [r.id, r.kind])).toEqual([
      ['public."Orders"', 'table'],
      ['public."odd.name/ü ""q"""', 'table'],
      ['public.audit_events', 'table'],
      ['public.customers', 'table'],
      ['public.daily_sales', 'materialized_view'],
      ['public.order_items', 'table'],
      ['public.order_totals', 'view'],
      ['public.orders', 'table'],
      ['public.page_views', 'partitioned_table'],
      ['public.products', 'table'],
      ['public.returns', 'table'],
    ]);
    const odd = rel(catalog, 'public."odd.name/ü ""q"""');
    expect([odd.schema, odd.name]).toEqual(['public', 'odd.name/ü "q"']);
    expect(catalog).toMatchObject({ format: 2, coverage: 'tapu-pg-v1', schemas: ['public'] });
    expect(catalog.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('captures columns with types, defaults, identity, generated expressions, comments and enum types', () => {
    const products = rel(catalog, 'public.products');
    expect(products.columns.map((c) => c.name)).toEqual(['id', 'sku', 'name', 'price_cents', 'price_with_tax_cents', 'currency']);
    expect(products.columns[0]).toMatchObject({ type: 'bigint', nullable: false, identity: 'always' });
    expect(products.columns[4]!.generated).toBe('((price_cents * 120) / 100)');
    expect(products.columns[5]).toMatchObject({ type: 'ext.currency', enumType: 'ext.currency' });

    const status = rel(catalog, 'public.orders').columns.find((c) => c.name === 'status')!;
    expect(status).toMatchObject({ type: 'public.order_status', default: "'pending'::public.order_status", enumType: 'public.order_status' });

    const customers = rel(catalog, 'public.customers');
    expect(customers.comment).toBe('Registered shop customers');
    expect(customers.columns.find((c) => c.name === 'tc_kimlik')!.comment).toBe('Turkish national ID number');
    // Enum arrays reference their element type.
    expect(customers.columns.find((c) => c.name === 'preferred_channels')).toMatchObject({
      type: 'public.contact_channel[]',
      enumType: 'public.contact_channel',
    });
    expect(rel(catalog, 'public.returns').columns[0]!.identity).toBe('by_default');
  });

  it('flags sensitive columns by name', () => {
    const flagged = (id: string) =>
      rel(catalog, id)
        .columns.filter((c) => c.sensitive)
        .map((c) => c.name);
    expect(flagged('public.customers')).toEqual(['email', 'phone', 'tc_kimlik']);
    expect(flagged('public.orders')).toEqual(['customer_email', 'shipping_address']);
    expect(flagged('public.audit_events')).toEqual(['ip_address']);
  });

  it('captures keys, checks and foreign keys with canonical definitions', () => {
    const items = rel(catalog, 'public.order_items');
    expect(items.primaryKey).toEqual({
      name: 'order_items_pkey',
      columns: ['order_id', 'product_id'],
      definition: 'PRIMARY KEY (order_id, product_id)',
    });
    expect(items.checks).toEqual([
      { name: 'order_items_quantity_positive', columns: ['quantity'], definition: 'CHECK (quantity > 0)' },
    ]);
    expect(items.foreignKeys[0]).toEqual({
      name: 'order_items_order_id_fkey',
      columns: ['order_id'],
      refSchema: 'public',
      refName: 'orders',
      ref: 'public.orders',
      refColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      match: 'simple',
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      definition: 'FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE',
    });
    expect(rel(catalog, 'public.returns').foreignKeys[0]).toMatchObject({
      columns: ['order_id', 'product_id'],
      ref: 'public.order_items',
      refColumns: ['order_id', 'product_id'],
      onUpdate: 'cascade',
      deferrable: true,
      initiallyDeferred: true,
      definition:
        'FOREIGN KEY (order_id, product_id) REFERENCES public.order_items(order_id, product_id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED',
    });
    // Targets outside the configured schemas keep their identifiers.
    expect(rel(catalog, 'public.customers').foreignKeys[0]).toMatchObject({ ref: 'ext.accounts', refSchema: 'ext' });
    expect(rel(catalog, 'public.customers').uniques).toEqual([
      { name: 'customers_email_key', columns: ['email'], definition: 'UNIQUE (email)' },
    ]);
    expect(rel(catalog, 'public.audit_events').primaryKey).toBeNull();
  });

  it('captures index keys, included columns, predicates, validity and constraint links', () => {
    const idx = (id: string, name: string) => rel(catalog, id).indexes.find((i) => i.name === name)!;
    expect(idx('public.customers', 'customers_lower_email_idx').keys).toEqual([{ expression: 'lower(email)' }]);
    expect(idx('public.customers', 'customers_account_id_idx').predicate).toBe('(account_id IS NOT NULL)');
    expect(idx('public.customers', 'customers_pkey')).toMatchObject({ primary: true, constraint: 'customers_pkey' });
    expect(idx('public.customers', 'customers_email_key')).toMatchObject({ unique: true, constraint: 'customers_email_key' });
    expect(idx('public.orders', 'orders_created_at_idx')).toMatchObject({ keys: [{ column: 'created_at' }], include: ['status'] });
    expect(idx('public.returns', 'returns_product_order_idx').keys).toEqual([
      { column: 'product_id' },
      { column: 'order_id' },
      { column: 'reason' },
    ]);
    expect(idx('public.audit_events', 'audit_events_action_key')).toMatchObject({ valid: false, unique: true, constraint: null });
    expect(idx('public.daily_sales', 'daily_sales_day_idx')).toMatchObject({ method: 'btree', unique: true, valid: true });
  });

  it('captures view definitions and partition keys without running them', () => {
    expect(rel(catalog, 'public.order_totals').viewDefinition).toContain('sum(i.quantity * i.unit_price_cents)');
    expect(rel(catalog, 'public.daily_sales').viewDefinition).toContain('count(*) AS order_count');
    const pv = rel(catalog, 'public.page_views');
    expect(pv.partitionKey).toBe('RANGE (viewed_at)');
    expect(pv.foreignKeys).toHaveLength(1);
    expect(pv.indexes.map((i) => i.name)).toEqual(['page_views_customer_id_idx']);
  });

  it('computes referencedBy from captured foreign keys only', () => {
    expect(rel(catalog, 'public.orders').referencedBy).toEqual([
      { from: 'public.order_items', name: 'order_items_order_id_fkey', columns: ['order_id'], refColumns: ['id'] },
    ]);
    expect(rel(catalog, 'public.customers').referencedBy.map((r) => r.from)).toEqual(['public.orders', 'public.page_views']);
  });

  it('captures configured enums, used or not, plus external enums that columns use', () => {
    expect(catalog.enums.map((e) => [e.id, e.values, e.external])).toEqual([
      ['ext.currency', ['TRY', 'EUR', 'USD'], true],
      ['public.contact_channel', ['email', 'sms', 'phone'], false],
      ['public.legacy_region', ['north', 'south'], false],
      ['public.order_status', ['pending', 'paid', 'shipped', 'cancelled'], false],
    ]);
  });

  it('uses null for unknown row estimates', () => {
    for (const r of catalog.relations) expect(r.rows).toBeNull();
  });

  it('includes a second schema only when configured', async () => {
    const both = await load(['public', 'billing']);
    expect(both.relations.map((r) => r.id)).toContain('billing.invoices');
    expect(rel(both, 'public.orders').referencedBy.map((r) => r.from)).toEqual(['billing.invoices', 'public.order_items']);
    expect(catalog.relations.map((r) => r.id)).not.toContain('billing.invoices');
    expect(both.revision).not.toBe(catalog.revision);
  });

  it('is deterministic; comments change only documentation hashes, structure changes structural hashes', async () => {
    const again = await load(['public']);
    expect(again).toEqual(catalog);

    await adminSql(`COMMENT ON TABLE public.orders IS 'changed comment'`);
    const commented = await load(['public']);
    expect(rel(commented, 'public.orders').hash).toBe(rel(catalog, 'public.orders').hash);
    expect(rel(commented, 'public.orders').docHash).not.toBe(rel(catalog, 'public.orders').docHash);
    expect(commented.revision).not.toBe(catalog.revision);

    await adminSql(`ALTER TYPE public.order_status ADD VALUE 'refunded'`);
    const enumChanged = await load(['public']);
    expect(rel(enumChanged, 'public.orders').hash).not.toBe(rel(catalog, 'public.orders').hash);
    expect(rel(enumChanged, 'public.customers').hash).toBe(rel(catalog, 'public.customers').hash);
    await resetFixture();
  });
});
