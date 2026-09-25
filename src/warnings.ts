import type { ForeignKey, Relation } from './catalog.js';

/** Frontmatter as Tapu reads it (see wiki.ts). Only these fields are recognized. */
export interface ColumnOverride {
  note?: string;
  sensitive?: boolean;
}

export interface Frontmatter {
  purpose: string;
  owner: string;
  tags: string[];
  /** Keyed by column name; a Map so names such as `__proto__` stay ordinary keys. */
  columns: Map<string, ColumnOverride>;
}

/** Deterministic warnings with stable codes (README, "Warnings"). */
export type Warning =
  | { code: 'no_primary_key' }
  | { code: 'fk_without_index'; columns: string[] }
  | { code: 'undocumented' }
  | { code: 'stale_note'; column: string }
  | { code: 'page_missing' }
  | { code: 'page_removed' }
  | { code: 'page_out_of_scope' }
  | { code: 'page_structure_mismatch'; pageState?: string }
  | { code: 'page_documentation_mismatch' }
  | { code: 'context_invalid'; reason: string; file?: string }
  | { code: 'rules_missing'; file: string };

/**
 * True when a valid, non-partial B-tree index has plain columns in its first N
 * key positions that are exactly the N foreign-key columns, in any order.
 * Included columns and expression keys never count. This is a conservative
 * structural heuristic, not a statement about query plans.
 */
export function fkHasIndex(rel: Relation, fk: ForeignKey): boolean {
  const n = fk.columns.length;
  const wanted = new Set(fk.columns);
  return rel.indexes.some((ix) => {
    if (!ix.valid || ix.predicate !== null || ix.method !== 'btree' || ix.keys.length < n) return false;
    const lead = ix.keys.slice(0, n);
    const cols = lead.map((k) => ('column' in k ? k.column : null));
    return cols.every((c) => c !== null && wanted.has(c)) && new Set(cols).size === n;
  });
}

/** Frontmatter column keys that are not columns of the relation. */
export function staleNotes(rel: Relation, front: Frontmatter | null): string[] {
  if (!front) return [];
  const names = new Set(rel.columns.map((c) => c.name));
  return [...front.columns.keys()].filter((name) => !names.has(name));
}

/** Warnings derived from structure and frontmatter, in a fixed order. Page warnings are added by callers. */
export function relationWarnings(rel: Relation, front: Frontmatter | null): Warning[] {
  const out: Warning[] = [];
  if ((rel.kind === 'table' || rel.kind === 'partitioned_table') && !rel.primaryKey) out.push({ code: 'no_primary_key' });
  const seen = new Set<string>();
  for (const fk of rel.foreignKeys) {
    const key = JSON.stringify(fk.columns);
    if (seen.has(key) || fkHasIndex(rel, fk)) continue;
    seen.add(key);
    out.push({ code: 'fk_without_index', columns: fk.columns });
  }
  if (!front?.purpose.trim() && !rel.comment?.trim()) out.push({ code: 'undocumented' });
  for (const column of staleNotes(rel, front)) out.push({ code: 'stale_note', column });
  return out;
}
