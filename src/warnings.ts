import type { ForeignKey, Relation } from './catalog.js';
import type { Frontmatter } from './wiki.js';

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** True when some index's leading columns are exactly the FK's columns (in any order). */
export function fkHasIndex(rel: Relation, fk: ForeignKey): boolean {
  const n = fk.columns.length;
  return rel.indexes.some((ix) => ix.columns.length >= n && sameSet(ix.columns.slice(0, n), fk.columns));
}

/** Frontmatter column keys that are not columns of the relation. */
export function staleNotes(rel: Relation, front: Frontmatter | null): string[] {
  if (!front) return [];
  const names = new Set(rel.columns.map((c) => c.name));
  return Object.keys(front.columns).filter((name) => !names.has(name));
}

/**
 * Deterministic warnings for a live relation, in a fixed order.
 * `drift` and `page_removed` depend on the page, not on the relation, and are added by callers.
 */
export function relationWarnings(rel: Relation, front: Frontmatter | null): string[] {
  const out: string[] = [];
  if ((rel.kind === 'table' || rel.kind === 'partitioned_table') && !rel.primaryKey) out.push('no_primary_key');
  for (const fk of rel.foreignKeys) {
    if (!fkHasIndex(rel, fk)) out.push(`fk_without_index: ${fk.columns.join(',')}`);
  }
  if (!front?.purpose.trim() && !rel.comment?.trim()) out.push('undocumented');
  for (const col of staleNotes(rel, front)) out.push(`stale_note: ${col}`);
  return out;
}
