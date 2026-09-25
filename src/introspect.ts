import {
  CATALOG_FORMAT,
  COVERAGE,
  byKey,
  catalogRevision,
  compareStrings,
  documentationHash,
  enumHash,
  structuralHash,
  structuralSections,
  type Catalog,
  type CheckConstraint,
  type Column,
  type EnumType,
  type FkAction,
  type ForeignKey,
  type Index,
  type IndexKey,
  type KeyConstraint,
  type Relation,
  type RelationKind,
} from './catalog.js';
import type { Session } from './db.js';
import { qualifiedId } from './ident.js';
import { isSensitiveName } from './sensitive.js';

// Every query below reads pg_catalog only, plus metadata functions such as
// format_type, pg_get_expr, pg_get_constraintdef, pg_get_indexdef,
// pg_get_viewdef and obj_description. Tapu never reads a row from a user
// table or view, never evaluates a captured expression, and never runs a
// captured view query. Row estimates come from pg_class.reltuples.

const RELATIONS_SQL = `
SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
       c.reltuples::float8 AS reltuples, obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition,
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key
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
       (CASE WHEN t.typtype = 'e' THEN t.oid WHEN et.typtype = 'e' THEN et.oid END)::int8 AS enum_oid
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
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
       fn.nspname AS ref_schema, fc.relname AS ref_name,
       con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update,
       con.confmatchtype::text AS match, con.condeferrable AS deferrable,
       con.condeferred AS deferred, con.convalidated AS validated,
       con.conindid::int8 AS index_oid
FROM pg_constraint con
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.conrelid = ANY($1::oid[])
  AND con.contype IN ('p', 'u', 'c', 'f')
  AND con.conparentid = 0`;

// columns: attribute names by position (NULL for expression keys);
// key_defs: pg_get_indexdef(index, position) for key positions.
const INDEXES_SQL = `
SELECT i.indrelid::int8 AS relid, i.indexrelid::int8 AS oid, ic.relname AS name, am.amname AS method,
       i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid,
       i.indnkeyatts AS nkey,
       pg_get_indexdef(i.indexrelid) AS definition,
       pg_get_expr(i.indpred, i.indrelid) AS predicate,
       ARRAY(SELECT a.attname::text FROM generate_series(0, i.indnatts - 1) AS k(pos)
             LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k.pos]
             ORDER BY k.pos) AS columns,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid, k.pos + 1, false)
             FROM generate_series(0, i.indnkeyatts - 1) AS k(pos)
             ORDER BY k.pos) AS key_defs
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_am am ON am.oid = ic.relam
WHERE i.indrelid = ANY($1::oid[])`;

// Enums in the configured schemas, plus enums elsewhere that a captured column uses.
const ENUMS_SQL = `
SELECT n.nspname AS schema, t.typname AS name, NOT (n.nspname = ANY($1::text[])) AS external, t.oid::int8 AS oid,
       ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'e' AND (n.nspname = ANY($1::text[]) OR t.oid = ANY($2::oid[]))`;

const KINDS: Record<string, RelationKind> = {
  r: 'table',
  p: 'partitioned_table',
  v: 'view',
  m: 'materialized_view',
};

const ACTIONS: Record<string, FkAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

const MATCH: Record<string, ForeignKey['match']> = { s: 'simple', f: 'full', p: 'partial' };

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

function indexFromRow(i: Row, constraintByIndex: Map<string, string>): Index {
  const cols = Array.isArray(i.columns) ? (i.columns as unknown[]) : [];
  const defs = strArray(i.key_defs);
  const nkey = Number(i.nkey);
  const keys: IndexKey[] = [];
  for (let pos = 0; pos < nkey; pos++) {
    const col = cols[pos];
    keys.push(col === null || col === undefined ? { expression: defs[pos] ?? '' } : { column: String(col) });
  }
  return {
    name: str(i.name),
    method: str(i.method),
    keys,
    include: cols.slice(nkey).map((c) => String(c)),
    unique: Boolean(i.unique),
    primary: Boolean(i.primary),
    valid: Boolean(i.valid),
    predicate: strOrNull(i.predicate),
    constraint: constraintByIndex.get(str(i.oid)) ?? null,
    definition: str(i.definition),
  };
}

/** Reads the configured schemas into a Catalog. Runs inside the caller's read-only session. */
export async function introspect(session: Session, schemas: string[], now: Date = new Date()): Promise<Catalog> {
  const relRows = await session.query(RELATIONS_SQL, [schemas]);
  const oids = relRows.map((r) => str(r.oid));

  // One connection runs one query at a time.
  const colRows = await session.query(COLUMNS_SQL, [oids]);
  const conRows = await session.query(CONSTRAINTS_SQL, [oids]);
  const idxRows = await session.query(INDEXES_SQL, [oids]);
  const enumOids = [...new Set(colRows.map((c) => c.enum_oid).filter((o) => o !== null).map(str))];
  const enumRows = await session.query(ENUMS_SQL, [schemas, enumOids]);

  const enums: EnumType[] = enumRows
    .map((e) => {
      const base = { schema: str(e.schema), name: str(e.name), values: strArray(e.values) };
      return { id: qualifiedId(base.schema, base.name), ...base, external: Boolean(e.external), hash: enumHash(base) };
    })
    .sort(byKey((e) => e.id));
  const enumIdByOid = new Map(enumRows.map((e) => [str(e.oid), qualifiedId(str(e.schema), str(e.name))]));
  const enumById = new Map(enums.map((e) => [e.id, e]));

  const colsByRel = groupBy(colRows);
  const consByRel = groupBy(conRows);
  const idxByRel = groupBy(idxRows);

  const relations: Relation[] = relRows.map((r) => {
    const oid = str(r.oid);
    const schema = str(r.schema);
    const name = str(r.name);
    const columns: Column[] = (colsByRel.get(oid) ?? []).map((c) => ({
      name: str(c.name),
      type: str(c.type),
      nullable: !c.notnull,
      default: strOrNull(c.default),
      identity: IDENTITY[str(c.identity)] ?? null,
      generated: strOrNull(c.generated),
      comment: strOrNull(c.comment),
      enumType: c.enum_oid === null ? null : (enumIdByOid.get(str(c.enum_oid)) ?? null),
      sensitive: isSensitiveName(str(c.name)),
    }));

    const cons = (consByRel.get(oid) ?? []).sort(byKey((c) => str(c.name)));
    const key = (c: Row): KeyConstraint => ({
      name: str(c.name),
      columns: strArray(c.columns),
      definition: str(c.definition),
    });
    const pk = cons.find((c) => c.type === 'p');
    const uniques = cons.filter((c) => c.type === 'u').map(key);
    const checks: CheckConstraint[] = cons.filter((c) => c.type === 'c').map(key);
    const foreignKeys: ForeignKey[] = cons
      .filter((c) => c.type === 'f')
      .map((c) => ({
        name: str(c.name),
        columns: strArray(c.columns),
        refSchema: str(c.ref_schema),
        refName: str(c.ref_name),
        ref: qualifiedId(str(c.ref_schema), str(c.ref_name)),
        refColumns: strArray(c.ref_columns),
        onDelete: ACTIONS[str(c.on_delete)] ?? 'no action',
        onUpdate: ACTIONS[str(c.on_update)] ?? 'no action',
        match: MATCH[str(c.match)] ?? 'simple',
        deferrable: Boolean(c.deferrable),
        initiallyDeferred: Boolean(c.deferred),
        validated: Boolean(c.validated),
        definition: str(c.definition),
      }));
    const constraintByIndex = new Map(
      cons.filter((c) => c.type === 'p' || c.type === 'u').map((c) => [str(c.index_oid), str(c.name)]),
    );
    const indexes = (idxByRel.get(oid) ?? [])
      .map((i) => indexFromRow(i, constraintByIndex))
      .sort(byKey((i) => i.name));

    const kind = KINDS[str(r.relkind)]!;
    const reltuples = Number(r.reltuples);
    const structure = {
      schema,
      name,
      kind,
      columns,
      primaryKey: pk ? key(pk) : null,
      uniques,
      checks,
      foreignKeys,
      indexes,
      viewDefinition: strOrNull(r.view_definition),
      partitionKey: strOrNull(r.partition_key),
    };
    const hash = structuralHash(structuralSections(structure, enumById));
    const comment = strOrNull(r.comment);
    return {
      id: qualifiedId(schema, name),
      ...structure,
      comment,
      rows: kind === 'view' || !(reltuples >= 0) ? null : Math.round(reltuples),
      referencedBy: [],
      hash,
      docHash: documentationHash(hash, { comment, columns }),
    };
  });

  relations.sort(byKey((r) => r.id));
  const byId = new Map(relations.map((r) => [r.id, r]));
  for (const rel of relations) {
    for (const fk of rel.foreignKeys) {
      byId.get(fk.ref)?.referencedBy.push({
        from: rel.id,
        name: fk.name,
        columns: fk.columns,
        refColumns: fk.refColumns,
      });
    }
  }
  for (const rel of relations) {
    rel.referencedBy.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.name, b.name));
  }

  const body = { schemas: [...schemas], relations, enums };
  return {
    format: CATALOG_FORMAT,
    coverage: COVERAGE,
    generatedAt: now.toISOString(),
    schemas: body.schemas,
    revision: catalogRevision(body),
    relations,
    enums,
  };
}
