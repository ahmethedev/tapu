import {
  catalogRevision,
  documentationHash,
  enumHash,
  structuralHash,
  structuralSections,
  type Catalog,
  type Column,
  type EnumType,
  type ForeignKey,
  type Index,
  type Relation,
} from '../src/catalog.js';
import { qualifiedId } from '../src/ident.js';

/** Synthetic catalog objects for pure-function tests. */
export function col(name: string, extra: Partial<Column> = {}): Column {
  return {
    name,
    type: 'text',
    nullable: true,
    default: null,
    identity: null,
    generated: null,
    comment: null,
    enumType: null,
    sensitive: false,
    ...extra,
  };
}

export function fk(columns: string[], ref = 'public.parent', extra: Partial<ForeignKey> = {}): ForeignKey {
  const [refSchema, refName] = ref.split('.') as [string, string];
  return {
    name: `fk_${columns.join('_')}`,
    columns,
    refSchema,
    refName,
    ref,
    refColumns: columns.map(() => 'id'),
    onDelete: 'no action',
    onUpdate: 'no action',
    match: 'simple',
    deferrable: false,
    initiallyDeferred: false,
    validated: true,
    definition: '',
    ...extra,
  };
}

export function index(name: string, keys: (string | { expression: string })[], extra: Partial<Index> = {}): Index {
  return {
    name,
    method: 'btree',
    keys: keys.map((k) => (typeof k === 'string' ? { column: k } : k)),
    include: [],
    unique: false,
    primary: false,
    valid: true,
    predicate: null,
    constraint: null,
    definition: `CREATE INDEX ${name}`,
    ...extra,
  };
}

export function enumType(schema: string, name: string, values: string[], external = false): EnumType {
  return { id: qualifiedId(schema, name), schema, name, values, external, hash: enumHash({ schema, name, values }) };
}

export function relation(name: string, extra: Partial<Relation> = {}, enums: EnumType[] = []): Relation {
  const base = {
    schema: 'public',
    name,
    kind: 'table' as const,
    comment: null,
    rows: null,
    columns: [col('id')],
    primaryKey: null,
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
    viewDefinition: null,
    partitionKey: null,
    referencedBy: [],
    ...extra,
  };
  const hash = structuralHash(structuralSections(base, new Map(enums.map((e) => [e.id, e]))));
  return { ...base, id: qualifiedId(base.schema, base.name), hash, docHash: documentationHash(hash, base) };
}

export function catalog(relations: Relation[], enums: EnumType[] = [], schemas = ['public']): Catalog {
  const body = { schemas, relations, enums };
  return {
    format: 2,
    coverage: 'tapu-pg-v1',
    generatedAt: '2026-09-25T10:30:00.000Z',
    ...body,
    revision: catalogRevision(body),
  };
}
