import { createHash } from 'node:crypto';

/** Format of `.tapu/catalog.json`. */
export const CATALOG_FORMAT = 2;

/** Identifier of the metadata that init/status capture and compare (see README, "Coverage"). */
export const COVERAGE = 'tapu-pg-v1';

/** What `tapu-pg-v1` does not compare. Returned by status and listed in the README. */
export const COVERAGE_LIMITS = [
  'functions and procedures',
  'triggers',
  'permissions and grants',
  'row-level security policies',
  'extension internals',
  'domain definitions',
  'exclusion constraints',
  'partition children (bounds, overrides, their own indexes)',
  'schemas outside the configured list',
  'application-level dependencies',
] as const;

export type RelationKind = 'table' | 'partitioned_table' | 'view' | 'materialized_view';

export type FkAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface Column {
  name: string;
  /** `format_type` output, schema-qualified for types outside pg_catalog. */
  type: string;
  nullable: boolean;
  default: string | null;
  identity: 'always' | 'by_default' | null;
  /** Generation expression of a generated column. */
  generated: string | null;
  comment: string | null;
  /** Canonical ID of the enum type (or of the element type of an enum array). */
  enumType: string | null;
  /** Automatic, name-based detection only (see sensitive.ts); frontmatter can override it. */
  sensitive: boolean;
}

export interface KeyConstraint {
  name: string;
  columns: string[];
  definition: string;
}

export interface CheckConstraint {
  name: string;
  columns: string[];
  definition: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refName: string;
  /** Canonical ID of the referenced relation (may be outside the configured schemas). */
  ref: string;
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
  match: 'simple' | 'full' | 'partial';
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  definition: string;
}

/** One key position of an index: a plain column or an expression. */
export type IndexKey = { column: string } | { expression: string };

export interface Index {
  name: string;
  method: string;
  keys: IndexKey[];
  include: string[];
  unique: boolean;
  primary: boolean;
  valid: boolean;
  predicate: string | null;
  /** Name of the primary key or unique constraint this index implements. */
  constraint: string | null;
  definition: string;
}

export interface Reference {
  /** Canonical ID of the referencing relation. */
  from: string;
  name: string;
  columns: string[];
  refColumns: string[];
}

export interface Relation {
  /** Canonical qualified ID (see ident.ts). */
  id: string;
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  /** `pg_class.reltuples`; null when negative (never analyzed) and for views. */
  rows: number | null;
  columns: Column[];
  primaryKey: KeyConstraint | null;
  uniques: KeyConstraint[];
  checks: CheckConstraint[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
  viewDefinition: string | null;
  partitionKey: string | null;
  /** Foreign keys of captured relations that point here. */
  referencedBy: Reference[];
  /** Structural hash (full SHA-256). */
  hash: string;
  /** Documentation hash: the structural hash plus table and column comments. */
  docHash: string;
}

export interface EnumType {
  id: string;
  schema: string;
  name: string;
  values: string[];
  /** Outside the configured schemas; loaded only because a captured column uses it. */
  external: boolean;
  hash: string;
}

export interface Catalog {
  format: typeof CATALOG_FORMAT;
  coverage: typeof COVERAGE;
  generatedAt: string;
  schemas: string[];
  /** Hash over schemas and structural/documentation content; excludes generatedAt and row estimates. */
  revision: string;
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

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function enumHash(e: Pick<EnumType, 'schema' | 'name' | 'values'>): string {
  return sha256([e.schema, e.name, e.values]);
}

type RelationStructure = Omit<Relation, 'hash' | 'docHash' | 'referencedBy' | 'id' | 'comment' | 'rows'>;

/**
 * The canonical structural content of a relation, one entry per section.
 * Semantic order (columns, enum values, index keys) is preserved; constraints
 * and indexes are sorted by name. Comments and row estimates are excluded.
 */
export function structuralSections(
  rel: RelationStructure,
  enums: Map<string, Pick<EnumType, 'schema' | 'name' | 'values'>>,
): Record<string, unknown> {
  const enumIds = [...new Set(rel.columns.map((c) => c.enumType).filter((e): e is string => e !== null))].sort(
    compareStrings,
  );
  return {
    kind: rel.kind,
    columns: rel.columns.map((c) => [c.name, c.type, c.nullable, c.default, c.identity, c.generated]),
    primaryKey: rel.primaryKey ? [rel.primaryKey.name, rel.primaryKey.columns, rel.primaryKey.definition] : null,
    uniques: rel.uniques.map((u) => [u.name, u.columns, u.definition]),
    checks: rel.checks.map((c) => [c.name, c.columns, c.definition]),
    foreignKeys: rel.foreignKeys.map((f) => [
      f.name,
      f.columns,
      f.refSchema,
      f.refName,
      f.refColumns,
      f.onDelete,
      f.onUpdate,
      f.match,
      f.deferrable,
      f.initiallyDeferred,
      f.validated,
      f.definition,
    ]),
    indexes: rel.indexes.map((i) => [
      i.name,
      i.method,
      i.keys,
      i.include,
      i.unique,
      i.primary,
      i.valid,
      i.predicate,
      i.definition,
    ]),
    view: rel.viewDefinition,
    partitionKey: rel.partitionKey,
    enums: enumIds.map((id) => {
      const e = enums.get(id);
      return e ? [e.schema, e.name, e.values] : [id, null];
    }),
  };
}

export function structuralHash(sections: Record<string, unknown>): string {
  return sha256(sections);
}

export function documentationHash(hash: string, rel: Pick<Relation, 'comment' | 'columns'>): string {
  return sha256([hash, rel.comment, rel.columns.map((c) => [c.name, c.comment])]);
}

export function catalogRevision(catalog: Pick<Catalog, 'schemas' | 'relations' | 'enums'>): string {
  return sha256({
    format: CATALOG_FORMAT,
    coverage: COVERAGE,
    schemas: catalog.schemas,
    relations: catalog.relations.map((r) => [r.id, r.hash, r.docHash]),
    enums: catalog.enums.map((e) => [e.id, e.hash, e.external]),
  });
}

export function relationMap(catalog: Catalog): Map<string, Relation> {
  return new Map(catalog.relations.map((r) => [r.id, r]));
}
