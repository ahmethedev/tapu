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
  });

  it('captures columns with types, defaults, identity, generated, comments and enum types', () => {
    const products = rel(catalog, 'public.products');
    expect(products.columns.map((c) => c.name)).toEqual([
      'id',
      'sku',
      'name',
      'price_cents',
      'price_with_tax_cents',
    ]);
    expect(products.columns[0]).toMatchObject({ type: 'bigint', nullable: false, identity: 'always' });
    expect(products.columns[4]!.generated).toBe('((price_cents * 120) / 100)');

    const orders = rel(catalog, 'public.orders');
    const status = orders.columns.find((c) => c.name === 'status')!;
    expect(status).toMatchObject({
      type: 'public.order_status',
      default: "'pending'::public.order_status",
      enumType: 'public.order_status',
    });

    const customers = rel(catalog, 'public.customers');
    expect(customers.comment).toBe('Registered shop customers');
    expect(customers.columns.find((c) => c.name === 'tc_kimlik')!.comment).toBe('Turkish national ID number');
    expect(rel(catalog, 'public.returns').columns[0]!.identity).toBe('by_default');
  });

  it('flags sensitive columns by name', () => {
    const flagged = (id: string) =>
      rel(catalog, id)
        .columns.filter((c) => c.sensitive)
        .map((c) => c.name);
    expect(flagged('public.customers')).toEqual(['email', 'phone', 'tc_kimlik']);
    expect(flagged('public.orders')).toEqual(['shipping_address']);
    expect(flagged('public.audit_events')).toEqual(['ip_address']);
  });

  it('captures keys, checks, foreign keys and indexes', () => {
    const items = rel(catalog, 'public.order_items');
    expect(items.primaryKey).toEqual({ name: 'order_items_pkey', columns: ['order_id', 'product_id'] });
    expect(items.checks).toEqual([
      { name: 'order_items_quantity_positive', definition: 'CHECK (quantity > 0)' },
    ]);
    expect(items.foreignKeys).toEqual([
      {
        name: 'order_items_order_id_fkey',
        columns: ['order_id'],
        refTable: 'public.orders',
        refColumns: ['id'],
        onDelete: 'cascade',
      },
      {
        name: 'order_items_product_id_fkey',
        columns: ['product_id'],
        refTable: 'public.products',
        refColumns: ['id'],
        onDelete: 'no action',
      },
    ]);

    expect(rel(catalog, 'public.returns').foreignKeys[0]).toMatchObject({
      columns: ['order_id', 'product_id'],
      refTable: 'public.order_items',
      refColumns: ['order_id', 'product_id'],
    });

    const customers = rel(catalog, 'public.customers');
    expect(customers.uniques).toEqual([{ name: 'customers_email_key', columns: ['email'] }]);
    expect(customers.indexes.map((i) => [i.name, i.columns, i.unique, i.primary])).toEqual([
      ['customers_email_key', ['email'], true, false],
      ['customers_lower_email_idx', [], false, false],
      ['customers_pkey', ['id'], true, true],
    ]);
    expect(customers.indexes[1]!.definition).toBe(
      'CREATE INDEX customers_lower_email_idx ON public.customers USING btree (lower(email))',
    );
    expect(rel(catalog, 'public.audit_events').primaryKey).toBeNull();
  });

  it('documents partitioned tables through the parent only', () => {
    const pv = rel(catalog, 'public.page_views');
    expect(pv.foreignKeys).toHaveLength(1);
    expect(pv.indexes.map((i) => i.name)).toEqual(['page_views_customer_id_idx']);
  });

  it('computes referencedBy', () => {
    expect(rel(catalog, 'public.orders').referencedBy).toEqual([
      { table: 'public.order_items', name: 'order_items_order_id_fkey', columns: ['order_id'], refColumns: ['id'] },
    ]);
    expect(rel(catalog, 'public.customers').referencedBy.map((r) => r.table)).toEqual([
      'public.orders',
      'public.page_views',
    ]);
  });

  it('captures enums with values in order', () => {
    expect(catalog.enums).toEqual([
      { id: 'public.order_status', values: ['pending', 'paid', 'shipped', 'cancelled'] },
    ]);
  });

  it('uses null for unknown row estimates', () => {
    for (const r of catalog.relations) expect(r.rows).toBeNull();
  });

  it('includes a second schema only when configured', async () => {
    const both = await load(['public', 'billing']);
    expect(both.relations.map((r) => r.id)).toContain('billing.invoices');
    expect(rel(both, 'public.orders').referencedBy.map((r) => r.table)).toEqual([
      'billing.invoices',
      'public.order_items',
    ]);
    expect(catalog.relations.map((r) => r.id)).not.toContain('billing.invoices');
  });

  it('is deterministic, and the hash ignores comments but tracks structure', async () => {
    const again = await load(['public']);
    expect(again).toEqual(catalog);

    await adminSql(`COMMENT ON TABLE public.orders IS 'changed comment'`);
    const commented = await load(['public']);
    expect(rel(commented, 'public.orders').hash).toBe(rel(catalog, 'public.orders').hash);

    await adminSql('ALTER TABLE public.orders ADD COLUMN note text');
    const altered = await load(['public']);
    expect(rel(altered, 'public.orders').hash).not.toBe(rel(catalog, 'public.orders').hash);
    expect(rel(altered, 'public.customers').hash).toBe(rel(catalog, 'public.customers').hash);
    expect(rel(catalog, 'public.orders').hash).toMatch(/^[0-9a-f]{16}$/);
    await resetFixture();
  });
});
