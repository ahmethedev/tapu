import type { Catalog, Column, Relation } from './catalog.js';
import { loadProject, type Config } from './project.js';
import { UNTRUSTED_NOTICE, sanitizeUntrusted, stripControlChars } from './sanitize.js';
import { relationWarnings } from './warnings.js';
import { isSensitive, readPages, type Frontmatter, type PageFile } from './wiki.js';

/** Human-written text. Every field is sanitized (see sanitize.ts). */
export interface Untrusted {
  purpose?: string;
  owner?: string;
  tags?: string[];
  comment?: string;
  colComments?: Record<string, string>;
  colNotes?: Record<string, string>;
  notes?: string;
}

export interface OverviewEntry {
  t: string;
  rows?: number;
  warn?: number;
  untrusted?: Pick<Untrusted, 'purpose' | 'notes'>;
}

export interface TableEntry {
  t: string;
  kind?: string;
  rows?: number;
  cols?: string[];
  pk?: string[];
  uniq?: string[];
  fk?: string[];
  refBy?: string[];
  idx?: string[];
  checks?: string[];
  warn?: string[];
  untrusted?: Untrusted;
}

export interface OverviewPayload {
  notice: string;
  overview: OverviewEntry[];
  enums: Record<string, string[]>;
}

export interface TablesPayload {
  notice: string;
  tables: TableEntry[];
  enums?: Record<string, string[]>;
}

export type ExplainPayload = OverviewPayload | TablesPayload;

export interface ExplainOptions {
  tables?: string[];
  notes?: boolean;
}

const TEMPLATE_BODY =
  '## Why it exists\n\n_Not documented yet. What does this table represent, who depends on it, what breaks if it changes?_\n\n## Notes';

/** A relation known to Tapu: live in the catalog, or only a page left behind. */
interface Subject {
  id: string;
  rel: Relation | null;
  page: PageFile | undefined;
  front: Frontmatter | null;
}

function subjects(catalog: Catalog, pages: Map<string, PageFile>): Subject[] {
  const out: Subject[] = [];
  const live = new Set(catalog.relations.map((r) => r.id));
  const front = (p: PageFile | undefined) => (p?.parse.ok ? p.parse.page.front : null);
  for (const rel of catalog.relations) {
    const page = pages.get(rel.id);
    out.push({ id: rel.id, rel, page, front: front(page) });
  }
  for (const page of pages.values()) {
    if (!live.has(page.id)) {
      out.push({ id: page.id, rel: null, page, front: front(page) });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function warnings(s: Subject): string[] {
  if (!s.rel) return ['page_removed'];
  const out = relationWarnings(s.rel, s.front).map((w) =>
    // Column names in stale notes come from human-written frontmatter.
    w.startsWith('stale_note: ') ? `stale_note: ${sanitizeUntrusted(w.slice(12), 64).replace(/\n/g, ' ')}` : w,
  );
  const pageHash = s.page?.parse.ok ? s.page.parse.page.hash : null;
  if (pageHash && pageHash !== s.rel.hash) out.push('drift');
  return out;
}

function clean(text: string | null | undefined): string | undefined {
  const t = text?.trim();
  return t ? sanitizeUntrusted(t) : undefined;
}

function pageNotes(s: Subject): string | undefined {
  if (!s.page?.parse.ok) return undefined;
  const body = s.page.parse.page.notes;
  return body === TEMPLATE_BODY ? undefined : clean(body);
}

function compact<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

// ---------------------------------------------------------------------------
// Column strings

function stripOwnCast(def: string, type: string): string {
  const suffix = `::${type}`;
  return def.endsWith(suffix) ? def.slice(0, -suffix.length) : def;
}

function onDeleteSuffix(onDelete: string): string {
  return onDelete === 'no action' ? '' : ` ON DELETE ${onDelete.toUpperCase()}`;
}

function columnString(rel: Relation, col: Column, front: Frontmatter | null): string {
  const pk = rel.primaryKey?.columns.length === 1 && rel.primaryKey.columns[0] === col.name;
  const parts = [col.name, col.type];
  if (!col.nullable && !pk) parts.push('NOT NULL');
  if (col.default !== null) parts.push(`DEFAULT ${stripOwnCast(col.default, col.type)}`);
  if (col.generated !== null) parts.push(`GENERATED AS ${col.generated}`);
  if (col.identity === 'always') parts.push('IDENTITY ALWAYS');
  if (col.identity === 'by_default') parts.push('IDENTITY BY DEFAULT');
  if (pk) parts.push('PK');
  if (rel.uniques.some((u) => u.columns.length === 1 && u.columns[0] === col.name)) parts.push('UNIQUE');
  for (const fk of rel.foreignKeys) {
    if (fk.columns.length === 1 && fk.columns[0] === col.name) {
      parts.push(`FK→${fk.refTable}.${fk.refColumns[0]}${onDeleteSuffix(fk.onDelete)}`);
    }
  }
  if (isSensitive(col, front)) parts.push('SENSITIVE');
  return parts.join(' ');
}

const list = (cols: string[]) => (cols.length === 1 ? cols[0]! : `(${cols.join(',')})`);

/** `orders_status_idx(status)`, `daily_sales_day_idx(day) UNIQUE`, `x gin (doc)`. */
function indexString(name: string, definition: string, unique: boolean): string {
  const m = / USING (\w+) (.*)$/.exec(definition);
  const body = m ? (m[1] === 'btree' ? m[2]! : ` ${m[1]} ${m[2]}`) : '';
  return `${name}${body}${unique ? ' UNIQUE' : ''}`;
}

function nonEmpty<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

function tableEntry(s: Subject, notes: boolean): TableEntry {
  const front = s.front;
  const untrusted = compact<Untrusted>({
    purpose: clean(front?.purpose),
    owner: clean(front?.owner),
    tags: front && front.tags.length > 0 ? front.tags.map((t) => sanitizeUntrusted(t)) : undefined,
    comment: clean(s.rel?.comment),
    colComments: s.rel
      ? compact(
          Object.fromEntries(
            s.rel.columns.filter((c) => c.comment?.trim()).map((c) => [c.name, sanitizeUntrusted(c.comment!.trim())]),
          ),
        )
      : undefined,
    colNotes: front
      ? compact(
          Object.fromEntries(
            Object.entries(front.columns)
              .filter(([, o]) => o.note?.trim())
              .map(([name, o]) => [sanitizeUntrusted(name, 64), sanitizeUntrusted(o.note!.trim())]),
          ),
        )
      : undefined,
    notes: notes ? pageNotes(s) : undefined,
  });

  const rel = s.rel;
  if (!rel) return compact<TableEntry>({ t: s.id, warn: warnings(s), untrusted })!;

  const constraintIndexes = new Set(rel.uniques.map((u) => u.name));
  return compact<TableEntry>({
    t: rel.id,
    kind: rel.kind,
    rows: rel.rows ?? undefined,
    cols: rel.columns.map((c) => columnString(rel, c, front)),
    pk: rel.primaryKey && rel.primaryKey.columns.length > 1 ? rel.primaryKey.columns : undefined,
    uniq: nonEmpty(rel.uniques.filter((u) => u.columns.length > 1).map((u) => list(u.columns))),
    fk: nonEmpty(
      rel.foreignKeys
        .filter((fk) => fk.columns.length > 1)
        .map((fk) => `${list(fk.columns)}→${fk.refTable}${list(fk.refColumns)}${onDeleteSuffix(fk.onDelete)}`),
    ),
    refBy: nonEmpty(rel.referencedBy.map((r) => `${r.table}.${list(r.columns)}`)),
    idx: nonEmpty(
      rel.indexes
        .filter((i) => !i.primary && !constraintIndexes.has(i.name))
        .map((i) => indexString(i.name, i.definition, i.unique)),
    ),
    checks: nonEmpty(rel.checks.map((c) => `${c.name}: ${c.definition}`)),
    warn: nonEmpty(warnings(s)),
    untrusted,
  })!;
}

function overviewEntry(s: Subject, notes: boolean): OverviewEntry {
  const warn = warnings(s).length;
  return compact<OverviewEntry>({
    t: s.id,
    rows: s.rel?.rows ?? undefined,
    warn: warn > 0 ? warn : undefined,
    untrusted: compact({
      purpose: clean(s.front?.purpose) ?? clean(s.rel?.comment),
      notes: notes ? pageNotes(s) : undefined,
    }),
  })!;
}

// ---------------------------------------------------------------------------
// Name resolution

export function resolveName(name: string, ids: string[], schemas: string[]): string {
  if (ids.includes(name)) return name;
  const candidates = schemas.map((schema) => `${schema}.${name}`).filter((id) => ids.includes(id));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`Ambiguous relation "${name}". Candidates: ${candidates.join(', ')}`);
  }
  throw new Error(`Unknown relation "${name}". Run \`tapu explain\` to list relations.`);
}

// ---------------------------------------------------------------------------

export function buildExplain(
  config: Config,
  catalog: Catalog,
  pages: Map<string, PageFile>,
  opts: ExplainOptions = {},
): ExplainPayload {
  const all = subjects(catalog, pages);
  const notes = opts.notes ?? false;
  const enumsOf = (ids: Set<string> | null) =>
    Object.fromEntries(catalog.enums.filter((e) => !ids || ids.has(e.id)).map((e) => [e.id, e.values]));

  if (!opts.tables || opts.tables.length === 0) {
    return { notice: UNTRUSTED_NOTICE, overview: all.map((s) => overviewEntry(s, notes)), enums: enumsOf(null) };
  }

  const ids = all.map((s) => s.id);
  const wanted = [...new Set(opts.tables.map((n) => resolveName(n, ids, config.schemas)))];
  const chosen = wanted.map((id) => all.find((s) => s.id === id)!);
  const usedEnums = new Set(chosen.flatMap((s) => s.rel?.columns.map((c) => c.enumType ?? '') ?? []));
  const enums = enumsOf(usedEnums);
  return {
    notice: UNTRUSTED_NOTICE,
    tables: chosen.map((s) => tableEntry(s, notes)),
    ...(Object.keys(enums).length > 0 ? { enums } : {}),
  };
}

/** Reads `.tapu/catalog.json` and the wiki pages. Never connects to the database. */
export async function explain(root: string, opts: ExplainOptions = {}): Promise<ExplainPayload> {
  const { config, catalog } = await loadProject(root);
  const pages = await readPages(root, config);
  return buildExplain(config, catalog, pages, opts);
}

// ---------------------------------------------------------------------------
// Human-readable output

function untrustedLines(u: Untrusted | undefined, indent: string): string[] {
  if (!u) return [];
  const out: string[] = [];
  const add = (label: string, text: string) =>
    out.push(`${indent}[untrusted] ${label}: ${text.replace(/\n/g, `\n${indent}    `)}`);
  if (u.purpose) add('purpose', u.purpose);
  if (u.owner) add('owner', u.owner);
  if (u.tags) add('tags', u.tags.join(', '));
  if (u.comment) add('comment', u.comment);
  for (const [col, text] of Object.entries(u.colComments ?? {})) add(`comment on ${col}`, text);
  for (const [col, text] of Object.entries(u.colNotes ?? {})) add(`note on ${col}`, text);
  if (u.notes) add('notes', u.notes);
  return out;
}

export function formatExplainHuman(payload: ExplainPayload): string {
  const lines = [`Note: ${payload.notice}`, ''];
  if ('overview' in payload) {
    lines.push(`${payload.overview.length} relations:`);
    for (const e of payload.overview) {
      const meta = [e.rows !== undefined ? `~${e.rows} rows` : undefined, e.warn ? `${e.warn} warnings` : undefined]
        .filter(Boolean)
        .join(', ');
      lines.push(`- ${e.t}${meta ? ` (${meta})` : ''}`, ...untrustedLines(e.untrusted, '    '));
    }
  } else {
    for (const t of payload.tables) {
      const meta = [t.kind, t.rows !== undefined ? `~${t.rows} rows` : undefined].filter(Boolean).join(', ');
      lines.push(`${t.t}${meta ? ` (${meta})` : ''}`);
      const section = (label: string, items: string[] | undefined) => {
        if (!items) return;
        lines.push(`  ${label}:`, ...items.map((i) => `    ${i}`));
      };
      section('columns', t.cols);
      section('primary key', t.pk ? [list(t.pk)] : undefined);
      section('unique', t.uniq);
      section('foreign keys', t.fk);
      section('referenced by', t.refBy);
      section('indexes', t.idx);
      section('checks', t.checks);
      section('warnings', t.warn);
      lines.push(...untrustedLines(t.untrusted, '  '), '');
    }
  }
  const enums = payload.enums ?? {};
  if (Object.keys(enums).length > 0) {
    lines.push('', 'Enums:');
    for (const [id, values] of Object.entries(enums)) lines.push(`- ${id}: ${values.join(', ')}`);
  }
  // Identifiers can contain control characters (e.g. terminal escapes) when quoted; JSON escapes them, text must not carry them.
  return stripControlChars(lines.join('\n').replace(/\n+$/, '')) + '\n';
}
