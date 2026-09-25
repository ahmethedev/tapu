import {
  CATALOG_VERSION,
  byKey,
  compareStrings,
  structuralHash,
  type Catalog,
  type Column,
  type EnumType,
  type ForeignKey,
  type Index,
  type KeyConstraint,
  type OnDelete,
  type Relation,
  type RelationKind,
} from './catalog.js';
import type { Session } from './db.js';
import { isSensitiveName } from './sensitive.js';

// Every query below reads pg_catalog only (plus pg_* helper functions).
// Tapu never reads a row from a user table; row counts come from reltuples.

const RELATIONS_SQL = `
SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
       c.reltuples::float8 AS reltuples, obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[])
  AND c.relkind IN ('r', 'p', 'v', 'm')
  AND NOT c.relispartition`;

const COLUMNS_SQL = `
SELECT a.attrelid::int8 AS relid, a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS notnull,
       CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS "default",
       CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated,
       a.attidentity::text AS identity,
       col_description(a.attrelid, a.attnum) AS comment,
       CASE WHEN t.typtype = 'e' THEN tn.nspname || '.' || t.typname END AS enum_type
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_namespace tn ON tn.oid = t.typnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum`;

// conparentid = 0 skips constraints cloned onto partitions.
const CONSTRAINTS_SQL = `
SELECT con.conrelid::int8 AS relid, con.conname AS name, con.contype::text AS type,
       pg_get_constraintdef(con.oid, true) AS definition,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num
             ORDER BY k.ord) AS columns,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num
             ORDER BY k.ord) AS ref_columns,
       fn.nspname || '.' || fc.relname AS ref_table,
       con.confdeltype::text AS on_delete
FROM pg_constraint con
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.conrelid = ANY($1::oid[])
  AND con.contype IN ('p', 'u', 'c', 'f')
  AND con.conparentid = 0`;

const INDEXES_SQL = `
SELECT i.indrelid::int8 AS relid, ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary,
       pg_get_indexdef(i.indexrelid) AS definition,
       ARRAY(SELECT a.attname::text FROM generate_series(0, i.indnkeyatts - 1) AS k(pos)
             LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k.pos]
             ORDER BY k.pos) AS columns
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = ANY($1::oid[])`;

const ENUMS_SQL = `
SELECT n.nspname || '.' || t.typname AS id,
       ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'e' AND n.nspname = ANY($1::text[])`;

const KINDS: Record<string, RelationKind> = {
  r: 'table',
  p: 'partitioned_table',
  v: 'view',
  m: 'materialized_view',
};

const ON_DELETE: Record<string, OnDelete> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

const IDENTITY: Record<string, Column['identity']> = { a: 'always', d: 'by_default' };

type Row = Record<string, unknown>;

function groupBy(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row.relid);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** Reads the schema of the given Postgres schemas into a Catalog. */
export async function introspect(
  session: Session,
  schemas: string[],
  now: Date = new Date(),
): Promise<Catalog> {
  const relRows = await session.query(RELATIONS_SQL, [schemas]);
  const oids = relRows.map((r) => str(r.oid));

  // One connection runs one query at a time.
  const colRows = await session.query(COLUMNS_SQL, [oids]);
  const conRows = await session.query(CONSTRAINTS_SQL, [oids]);
  const idxRows = await session.query(INDEXES_SQL, [oids]);
  const enumRows = await session.query(ENUMS_SQL, [schemas]);
  const colsByRel = groupBy(colRows);
  const consByRel = groupBy(conRows);
  const idxByRel = groupBy(idxRows);

  const relations: Relation[] = relRows.map((r) => {
    const oid = str(r.oid);
    const columns: Column[] = (colsByRel.get(oid) ?? []).map((c) => ({
      name: str(c.name),
      type: str(c.type),
      nullable: !c.notnull,
      default: strOrNull(c.default),
      identity: IDENTITY[str(c.identity)] ?? null,
      generated: strOrNull(c.generated),
      comment: strOrNull(c.comment),
      enumType: strOrNull(c.enum_type),
      sensitive: isSensitiveName(str(c.name)),
    }));

    const cons = (consByRel.get(oid) ?? []).sort(byKey((c) => str(c.name)));
    const pk = cons.find((c) => c.type === 'p');
    const primaryKey: KeyConstraint | null = pk ? { name: str(pk.name), columns: strArray(pk.columns) } : null;
    const uniques = cons
      .filter((c) => c.type === 'u')
      .map((c) => ({ name: str(c.name), columns: strArray(c.columns) }));
    const checks = cons
      .filter((c) => c.type === 'c')
      .map((c) => ({ name: str(c.name), definition: str(c.definition) }));
    const foreignKeys: ForeignKey[] = cons
      .filter((c) => c.type === 'f')
      .map((c) => ({
        name: str(c.name),
        columns: strArray(c.columns),
        refTable: str(c.ref_table),
        refColumns: strArray(c.ref_columns),
        onDelete: ON_DELETE[str(c.on_delete)] ?? 'no action',
      }));

    const indexes: Index[] = (idxByRel.get(oid) ?? [])
      .map((i) => {
        const raw = Array.isArray(i.columns) ? (i.columns as unknown[]) : [];
        const firstExpr = raw.findIndex((c) => c === null);
        const plain = (firstExpr === -1 ? raw : raw.slice(0, firstExpr)).map((c) => String(c));
        return {
          name: str(i.name),
          columns: plain,
          unique: Boolean(i.unique),
          primary: Boolean(i.primary),
          definition: str(i.definition),
        };
      })
      .sort(byKey((i) => i.name));

    const reltuples = Number(r.reltuples);
    const kind = KINDS[str(r.relkind)]!;
    const base = {
      id: `${str(r.schema)}.${str(r.name)}`,
      schema: str(r.schema),
      name: str(r.name),
      kind,
      comment: strOrNull(r.comment),
      rows: kind === 'view' || !(reltuples >= 0) ? null : Math.round(reltuples),
      columns,
      primaryKey,
      uniques,
      checks,
      foreignKeys,
      indexes,
    };
    return { ...base, referencedBy: [], hash: structuralHash(base) };
  });

  relations.sort(byKey((r) => r.id));
  const byId = new Map(relations.map((r) => [r.id, r]));
  for (const rel of relations) {
    for (const fk of rel.foreignKeys) {
      byId.get(fk.refTable)?.referencedBy.push({
        table: rel.id,
        name: fk.name,
        columns: fk.columns,
        refColumns: fk.refColumns,
      });
    }
  }
  for (const rel of relations) {
    rel.referencedBy.sort((a, b) => compareStrings(a.table, b.table) || compareStrings(a.name, b.name));
  }

  const enums: EnumType[] = enumRows
    .map((e) => ({ id: str(e.id), values: strArray(e.values) }))
    .sort(byKey((e) => e.id));

  return {
    version: CATALOG_VERSION,
    generatedAt: now.toISOString(),
    schemas: [...schemas],
    relations,
    enums,
  };
}
