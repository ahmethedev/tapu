import { createHash } from 'node:crypto';

export const CATALOG_VERSION = 1;

export type RelationKind = 'table' | 'partitioned_table' | 'view' | 'materialized_view';

export type OnDelete = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface Column {
  name: string;
  /** `format_type` output, schema-qualified for non-catalog types. */
  type: string;
  nullable: boolean;
  default: string | null;
  identity: 'always' | 'by_default' | null;
  /** Generation expression of a generated column. */
  generated: string | null;
  comment: string | null;
  /** `schema.name` of the enum type, when the column is enum-typed. */
  enumType: string | null;
  /** Result of name-based detection (see sensitive.ts); frontmatter can override it. */
  sensitive: boolean;
}

export interface KeyConstraint {
  name: string;
  columns: string[];
}

export interface CheckConstraint {
  name: string;
  definition: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: OnDelete;
}

export interface Index {
  name: string;
  /** Leading plain key columns in order; stops at the first expression (empty for expression-only indexes). */
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition: string;
}

export interface Reference {
  table: string;
  name: string;
  columns: string[];
  refColumns: string[];
}

export interface Relation {
  /** `schema.name` */
  id: string;
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  /** `pg_class.reltuples`, or null when unknown (never analyzed, views). */
  rows: number | null;
  columns: Column[];
  primaryKey: KeyConstraint | null;
  uniques: KeyConstraint[];
  checks: CheckConstraint[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
  referencedBy: Reference[];
  hash: string;
}

export interface EnumType {
  id: string;
  values: string[];
}

export interface Catalog {
  version: typeof CATALOG_VERSION;
  generatedAt: string;
  schemas: string[];
  relations: Relation[];
  enums: EnumType[];
}

/** Locale-independent comparison so ordering never depends on the machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compareStrings(key(a), key(b));
}

/**
 * Structural hash: sha256 (first 16 hex chars) over kind, columns, keys,
 * checks and index definitions. Comments and row estimates are excluded.
 */
export function structuralHash(rel: Omit<Relation, 'hash' | 'referencedBy'>): string {
  const canonical = {
    kind: rel.kind,
    columns: rel.columns.map((c) => [c.name, c.type, c.nullable, c.default, c.identity, c.generated]),
    primaryKey: rel.primaryKey ? [rel.primaryKey.name, rel.primaryKey.columns] : null,
    foreignKeys: rel.foreignKeys.map((f) => [f.name, f.columns, f.refTable, f.refColumns, f.onDelete]),
    uniques: rel.uniques.map((u) => [u.name, u.columns]),
    checks: rel.checks.map((c) => c.definition),
    indexes: rel.indexes.map((i) => i.definition),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export function relationMap(catalog: Catalog): Map<string, Relation> {
  return new Map(catalog.relations.map((r) => [r.id, r]));
}
