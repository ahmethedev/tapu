import type { Catalog, Column, ForeignKey, Index, KeyConstraint, Relation, RelationKind } from './catalog.js';
import { COVERAGE, compareStrings, sha256 } from './catalog.js';
import { TapuError, errorMessage } from './errors.js';
import { ProjectFs } from './fsafe.js';
import { parseQualifiedName, qualifiedId, quoteIdent } from './ident.js';
import { loadProject, wikiPaths, type Config } from './project.js';
import { LIMITS, NOTICE, Untrusted, terminalSafe } from './sanitize.js';
import { relationWarnings, type Warning } from './warnings.js';
import {
  RULES_TEMPLATE,
  humanNotes,
  isSensitive,
  pageFront,
  readPages,
  type Frontmatter,
  type PageFile,
  type PageState,
} from './wiki.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_TABLES = 20;
export const MAX_NEIGHBORS = 20;

export interface ExplainRequest {
  tables?: string[];
  search?: string;
  related?: boolean;
  notes?: boolean;
  rules?: boolean;
  limit?: number;
  cursor?: string;
}

export interface Source {
  kind: 'local_snapshot';
  generatedAt: string;
  revision: string;
}

export interface ContextFiles {
  rules: { path: string; available: boolean; empty?: true };
}

/** A context problem that is not tied to one relation (per-relation ones are in `warn`). */
export type Finding = Warning | { code: 'scope_mismatch'; configured: string[]; snapshot: string[] };

interface Envelope {
  notice: string;
  source: Source;
  coverage: typeof COVERAGE;
  contextFiles: ContextFiles;
}

interface Extras {
  untrusted?: { rules?: string };
  findings?: Finding[];
  /** JSON Pointers of untrusted fields cut to the output limits. */
  truncated?: string[];
  /** Explicitly requested context (notes or rules) could not be read; exit code 2. */
  partial?: true;
}

export interface Summary {
  t: string;
  kind: RelationKind;
  columns: number;
  warn?: number;
  matchedCols?: string[];
  untrusted?: { purpose: string };
}

export interface DiscoveryPayload extends Envelope, Extras {
  search?: string;
  page: { total: number; limit: number; nextCursor: string | null };
  overview?: Summary[];
  matches?: Summary[];
}

export interface TableUntrusted {
  purpose?: string;
  owner?: string;
  tags?: string[];
  comment?: string;
  colComments?: Record<string, string>;
  colNotes?: Record<string, string>;
  notes?: string;
}

export interface TableEntry {
  t: string;
  state: PageState;
  kind?: RelationKind;
  rows?: number;
  cols?: string[];
  pk?: string;
  uniq?: string[];
  fk?: string[];
  refBy?: string[];
  idx?: string[];
  checks?: string[];
  view?: string;
  partitionKey?: string;
  warn?: Warning[];
  contextFile?: string;
  untrusted?: TableUntrusted;
}

export interface EnumEntry {
  t: string;
  values: string[];
  external?: true;
}

export interface Selection {
  requested: string[];
  neighbors?: string[];
  omittedNeighbors?: number;
  /** Relations referenced by foreign keys of returned tables that have no captured definition. */
  external?: string[];
}

export interface DetailPayload extends Envelope, Extras {
  selection: Selection;
  tables: TableEntry[];
  enums?: EnumEntry[];
}

export type ExplainPayload = DiscoveryPayload | DetailPayload;

export interface ExplainResult {
  payload: ExplainPayload;
  exitCode: 0 | 2;
}

// ---------------------------------------------------------------------------
// Compact structure strings (grammar documented in the README)

const upper = (s: string) => s.toUpperCase();
const identList = (cols: string[]) => cols.map(quoteIdent).join(', ');
const compactList = (cols: string[]) => (cols.length === 1 ? quoteIdent(cols[0]!) : `(${cols.map(quoteIdent).join(',')})`);

/** The definition PostgreSQL prints for a foreign key with these fields, when identifiers need no keyword quoting. */
function fkDefinition(fk: ForeignKey): string {
  let s = `FOREIGN KEY (${identList(fk.columns)}) REFERENCES ${fk.ref}(${identList(fk.refColumns)})`;
  if (fk.match === 'full') s += ' MATCH FULL';
  if (fk.onUpdate !== 'no action') s += ` ON UPDATE ${upper(fk.onUpdate)}`;
  if (fk.onDelete !== 'no action') s += ` ON DELETE ${upper(fk.onDelete)}`;
  if (fk.deferrable) s += ' DEFERRABLE';
  if (fk.initiallyDeferred) s += ' INITIALLY DEFERRED';
  if (!fk.validated) s += ' NOT VALID';
  return s;
}

/** Modifiers after an FK target; `null` when the compact form would lose part of the definition. */
function fkModifiers(fk: ForeignKey): string | null {
  if (fkDefinition(fk) !== fk.definition) return null;
  let s = '';
  if (fk.onDelete !== 'no action') s += ` ON DELETE ${upper(fk.onDelete)}`;
  if (fk.onUpdate !== 'no action') s += ` ON UPDATE ${upper(fk.onUpdate)}`;
  if (fk.match !== 'simple') s += ` MATCH ${upper(fk.match)}`;
  if (fk.deferrable) s += fk.initiallyDeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE';
  if (!fk.validated) s += ' NOT VALID';
  return s;
}

function keyIsPlain(k: KeyConstraint, word: string): boolean {
  return k.definition === `${word} (${identList(k.columns)})`;
}

/** `(name)` when a constraint does not have PostgreSQL's default name. */
function nameSuffix(actual: string, defaultName: string): string {
  return actual === defaultName ? '' : `(${quoteIdent(actual)})`;
}

/** A trailing cast to the column's own type is implied by assignment and left out. */
function stripOwnCast(def: string, type: string): string {
  const suffix = `::${type}`;
  return def.endsWith(suffix) ? def.slice(0, -suffix.length) : def;
}

interface Structure {
  cols: string[];
  pk?: string;
  uniq: string[];
  fk: string[];
}

function structure(rel: Relation, front: Frontmatter | null): Structure {
  const pk = rel.primaryKey;
  const inlinePk = pk && pk.columns.length === 1 && keyIsPlain(pk, 'PRIMARY KEY') ? pk : null;
  const inlineUniq = rel.uniques.filter((u) => u.columns.length === 1 && keyIsPlain(u, 'UNIQUE'));
  const inlineFk = rel.foreignKeys.filter((fk) => fk.columns.length === 1 && fkModifiers(fk) !== null);

  const cols = rel.columns.map((col: Column) => {
    const parts = [quoteIdent(col.name), col.type];
    const isPk = inlinePk?.columns[0] === col.name;
    if (!col.nullable && !isPk) parts.push('NOT NULL');
    if (isPk) parts.push('PK' + nameSuffix(inlinePk!.name, `${rel.name}_pkey`));
    for (const u of inlineUniq) {
      if (u.columns[0] === col.name) parts.push('UNIQUE' + nameSuffix(u.name, `${rel.name}_${col.name}_key`));
    }
    for (const fk of inlineFk) {
      if (fk.columns[0] !== col.name) continue;
      parts.push(
        `FK${nameSuffix(fk.name, `${rel.name}_${col.name}_fkey`)}→${fk.ref}.${quoteIdent(fk.refColumns[0]!)}${fkModifiers(fk)}`,
      );
    }
    if (col.identity === 'always') parts.push('IDENTITY ALWAYS');
    if (col.identity === 'by_default') parts.push('IDENTITY BY DEFAULT');
    if (isSensitive(col, front)) parts.push('SENSITIVE');
    if (col.generated !== null) parts.push(`GENERATED AS ${col.generated}`);
    else if (col.default !== null) parts.push(`DEFAULT ${stripOwnCast(col.default, col.type)}`);
    return parts.join(' ');
  });

  const uniq = rel.uniques
    .filter((u) => !inlineUniq.includes(u))
    .map((u) => (keyIsPlain(u, 'UNIQUE') ? `${quoteIdent(u.name)}${compactList(u.columns)}` : `${quoteIdent(u.name)}: ${u.definition}`));
  const fk = rel.foreignKeys
    .filter((f) => !inlineFk.includes(f))
    .map((f) => {
      const mods = fkModifiers(f);
      return mods === null
        ? `${quoteIdent(f.name)}: ${f.definition}`
        : `${quoteIdent(f.name)}${compactList(f.columns)}→${f.ref}${compactList(f.refColumns)}${mods}`;
    });
  const out: Structure = { cols, uniq, fk };
  if (pk && !inlinePk) {
    out.pk = keyIsPlain(pk, 'PRIMARY KEY') ? `${quoteIdent(pk.name)}${compactList(pk.columns)}` : `${quoteIdent(pk.name)}: ${pk.definition}`;
  }
  return out;
}

/** `orders_status_idx(status)`, `x UNIQUE INVALID gin (doc)`; the full definition when the table part cannot be stripped. */
function indexString(rel: Relation, ix: Index): string {
  const head = `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(ix.name)} ON `;
  const using = ` USING ${ix.method} `;
  for (const on of [rel.id, `ONLY ${rel.id}`]) {
    const prefix = head + on + using;
    if (ix.definition.startsWith(prefix)) {
      const flags = (ix.unique ? ' UNIQUE' : '') + (ix.valid ? '' : ' INVALID') + (ix.method === 'btree' ? '' : ` ${ix.method}`);
      return `${quoteIdent(ix.name)}${flags}${flags ? ' ' : ''}${ix.definition.slice(prefix.length)}`;
    }
  }
  return `${quoteIdent(ix.name)}: ${ix.definition}${ix.valid ? '' : ' INVALID'}`;
}

// ---------------------------------------------------------------------------
// Subjects: live relations, plus pages left behind by removed/out-of-scope relations

interface Subject {
  id: string;
  schema: string;
  name: string;
  rel: Relation | null;
  page: PageFile | undefined;
  state: PageState;
}

function subjects(config: Config, catalog: Catalog, pages: Map<string, PageFile>): Map<string, Subject> {
  const out = new Map<string, Subject>();
  for (const rel of catalog.relations) {
    out.set(rel.id, { id: rel.id, schema: rel.schema, name: rel.name, rel, page: pages.get(rel.id), state: 'active' });
  }
  const inScope = new Set(config.schemas);
  for (const page of pages.values()) {
    if (out.has(page.id)) continue;
    const state = inScope.has(page.schema) ? 'removed' : 'out_of_scope';
    out.set(page.id, { id: page.id, schema: page.schema, name: page.name, rel: null, page, state });
  }
  return out;
}

/** Local warnings: structure, frontmatter, and page vs catalog. Explain never sees the live database. */
function warningsOf(s: Subject): Warning[] {
  const page = s.page;
  if (!s.rel) {
    const out: Warning[] = [{ code: s.state === 'removed' ? 'page_removed' : 'page_out_of_scope' }];
    if (page && !page.parse.ok) out.push({ code: 'context_invalid', reason: page.parse.reason, file: page.path });
    return out;
  }
  const invalid = page !== undefined && !page.parse.ok;
  const out = relationWarnings(s.rel, pageFront(page)).filter((w) => !(invalid && w.code === 'undocumented'));
  if (!page) out.push({ code: 'page_missing' });
  else if (!page.parse.ok) out.push({ code: 'context_invalid', reason: page.parse.reason, file: page.path });
  else {
    const p = page.parse.page;
    if (p.state !== 'active') out.push({ code: 'page_structure_mismatch', pageState: p.state });
    else if (p.hash !== s.rel.hash) out.push({ code: 'page_structure_mismatch' });
    else if (p.docHash !== s.rel.docHash) out.push({ code: 'page_documentation_mismatch' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entries

function summary(s: Subject, u: Untrusted, path: (string | number)[]): Summary {
  const rel = s.rel!;
  const out: Summary = { t: rel.id, kind: rel.kind, columns: rel.columns.length };
  const warn = warningsOf(s).length;
  if (warn > 0) out.warn = warn;
  const purpose = u.text(pageFront(s.page)?.purpose, LIMITS.overviewPurpose, [...path, 'untrusted', 'purpose']);
  if (purpose) out.untrusted = { purpose };
  return out;
}

function record(entries: [string, string | undefined][]): Record<string, string> | undefined {
  const out: Record<string, string> = Object.create(null);
  let any = false;
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : undefined;
}

function tableUntrusted(
  s: Subject,
  front: Frontmatter | null,
  notes: string | undefined,
  u: Untrusted,
  path: (string | number)[],
): TableUntrusted | undefined {
  const p = [...path, 'untrusted'];
  const out: TableUntrusted = {};
  const set = <K extends keyof TableUntrusted>(k: K, v: TableUntrusted[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('purpose', u.text(front?.purpose, LIMITS.field, [...p, 'purpose']));
  set('owner', u.text(front?.owner, LIMITS.field, [...p, 'owner']));
  const tags = (front?.tags ?? [])
    .map((t, i) => u.text(t, LIMITS.field, [...p, 'tags', i]))
    .filter((t): t is string => t !== undefined);
  if (tags.length > 0) out.tags = tags;
  if (s.rel) {
    set('comment', u.text(s.rel.comment, LIMITS.field, [...p, 'comment']));
    set(
      'colComments',
      record(s.rel.columns.map((c) => [c.name, u.text(c.comment, LIMITS.field, [...p, 'colComments', c.name])])),
    );
  }
  if (front) {
    set(
      'colNotes',
      record(
        [...front.columns].map(([name, o]) => {
          const key = u.text(name, LIMITS.field, [...p, 'colNotes', name]) ?? '';
          return [key, u.text(o.note, LIMITS.field, [...p, 'colNotes', key])];
        }),
      ),
    );
  }
  set('notes', notes);
  return Object.keys(out).length > 0 ? out : undefined;
}

interface EntryContext {
  u: Untrusted;
  findings: Finding[];
  partial: { value: boolean };
}

function tableEntry(s: Subject, withNotes: boolean, index: number, ec: EntryContext): TableEntry {
  const path = ['tables', index];
  const page = s.page;
  const front = pageFront(page);
  const entry: TableEntry = { t: s.id, state: s.state };

  let notes: string | undefined;
  if (withNotes && page?.parse.ok) {
    notes = ec.u.text(humanNotes(page.parse.page, s.id), LIMITS.long, [...path, 'untrusted', 'notes']);
  } else if (withNotes && page) {
    ec.partial.value = true; // explicitly requested notes cannot be read safely
  }

  const rel = s.rel;
  if (rel) {
    const st = structure(rel, front);
    entry.kind = rel.kind;
    if (rel.rows !== null) entry.rows = rel.rows;
    entry.cols = st.cols;
    if (st.pk) entry.pk = st.pk;
    if (st.uniq.length > 0) entry.uniq = st.uniq;
    if (st.fk.length > 0) entry.fk = st.fk;
    if (rel.referencedBy.length > 0) entry.refBy = rel.referencedBy.map((r) => `${r.from}.${compactList(r.columns)}`);
    const idx = rel.indexes.filter((ix) => ix.constraint === null).map((ix) => indexString(rel, ix));
    if (idx.length > 0) entry.idx = idx;
    if (rel.checks.length > 0) entry.checks = rel.checks.map((c) => `${quoteIdent(c.name)}: ${c.definition}`);
    if (rel.viewDefinition !== null) entry.view = rel.viewDefinition.trim();
    if (rel.partitionKey !== null) entry.partitionKey = rel.partitionKey;
  }
  const warn = warningsOf(s).map((w, i) =>
    w.code === 'stale_note'
      ? { code: w.code, column: ec.u.text(w.column, LIMITS.field, [...path, 'warn', i, 'column']) ?? '' }
      : w,
  );
  if (warn.length > 0) entry.warn = warn;
  if (page) entry.contextFile = page.path;
  const untrusted = tableUntrusted(s, front, notes, ec.u, path);
  if (untrusted) entry.untrusted = untrusted;
  return entry;
}

// ---------------------------------------------------------------------------
// Requests

function invalid(message: string, details?: Record<string, unknown>): TapuError {
  return new TapuError('invalid_arguments', message, details);
}

export function validateRequest(req: ExplainRequest): void {
  const detail = (req.tables?.length ?? 0) > 0;
  if (detail && (req.search !== undefined || req.cursor !== undefined || req.limit !== undefined)) {
    throw invalid('Relation names cannot be combined with search, cursor or limit. Request details by name, or discover first.', {
      conflicting: ['tables', ...(['search', 'cursor', 'limit'] as const).filter((k) => req[k] !== undefined)],
    });
  }
  if (!detail && (req.related || req.notes)) {
    throw invalid('--related and --notes need explicit relation names, e.g. tapu explain orders --related --notes.', {
      conflicting: (['related', 'notes'] as const).filter((k) => req[k]),
    });
  }
  if (req.limit !== undefined && !(Number.isInteger(req.limit) && req.limit >= 1 && req.limit <= MAX_LIMIT)) {
    throw invalid(`limit must be an integer from 1 to ${MAX_LIMIT}.`, { limit: req.limit, max: MAX_LIMIT });
  }
  if (req.search !== undefined && req.search.trim() === '') throw invalid('search text must not be empty.');
}

interface Problem {
  input: string;
  code: 'invalid_name' | 'unknown_relation' | 'ambiguous_name';
  candidates?: string[];
}

function resolveNames(inputs: string[], config: Config, all: Map<string, Subject>): string[] {
  const ids: string[] = [];
  const problems: Problem[] = [];
  for (const input of inputs) {
    const parts = parseQualifiedName(input);
    if (!parts) {
      problems.push({ input, code: 'invalid_name' });
      continue;
    }
    const candidates =
      parts.length === 2
        ? [qualifiedId(parts[0]!, parts[1]!)].filter((id) => all.has(id))
        : config.schemas.map((schema) => qualifiedId(schema, parts[0]!)).filter((id) => all.has(id));
    if (candidates.length === 1) ids.push(candidates[0]!);
    else if (candidates.length > 1) problems.push({ input, code: 'ambiguous_name', candidates });
    else {
      const name = parts[parts.length - 1]!.toLowerCase();
      const similar = [...all.values()].filter((s) => s.name.toLowerCase() === name).map((s) => s.id);
      problems.push({ input, code: 'unknown_relation', ...(similar.length > 0 ? { candidates: similar } : {}) });
    }
  }
  if (problems.length > 0) {
    const first = problems[0]!;
    const message = {
      invalid_name: `"${first.input}" is not a valid relation name. Use name, schema.name or "Quoted"."Name".`,
      ambiguous_name: `"${first.input}" matches several relations; use a qualified name: ${first.candidates?.join(', ')}.`,
      unknown_relation: `Unknown relation "${first.input}". Use tapu explain --search <text> to find it.`,
    }[first.code];
    throw new TapuError(first.code, message, { problems, next: 'tapu explain --search <text>' });
  }
  return [...new Set(ids)];
}

function cursorBinding(revision: string, search: string | null): string {
  return sha256(['tapu-explain-cursor-1', revision, search]).slice(0, 24);
}

function encodeCursor(offset: number, binding: string): string {
  return Buffer.from(JSON.stringify({ o: offset, b: binding })).toString('base64url');
}

function decodeCursor(cursor: string, binding: string, total: number): number {
  const restart = { next: 'Restart discovery without --cursor.' };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TapuError('cursor_invalid', 'The cursor is malformed. Restart discovery without --cursor.', restart);
  }
  const v = value as { o?: unknown; b?: unknown };
  if (!v || typeof v !== 'object' || !Number.isInteger(v.o) || (v.o as number) < 0 || typeof v.b !== 'string') {
    throw new TapuError('cursor_invalid', 'The cursor is malformed. Restart discovery without --cursor.', restart);
  }
  if (v.b !== binding || (v.o as number) >= Math.max(total, 1)) {
    throw new TapuError(
      'cursor_invalid',
      'The cursor belongs to a different snapshot or search. The catalog may have been refreshed; restart discovery without --cursor.',
      restart,
    );
  }
  return v.o as number;
}

async function readRules(
  fs: ProjectFs,
  config: Config,
  want: boolean,
  ec: EntryContext,
): Promise<{ files: ContextFiles; rules?: string }> {
  const path = wikiPaths(config).rules;
  let text: string | null;
  try {
    text = await fs.read(path);
  } catch (err) {
    if (want) {
      const reason = err instanceof TapuError ? err.message : `cannot be read (${errorMessage(err)})`;
      ec.findings.push({ code: 'context_invalid', reason, file: path });
      ec.partial.value = true;
    }
    return { files: { rules: { path, available: false } } };
  }
  if (text === null) {
    if (want) ec.findings.push({ code: 'rules_missing', file: path });
    return { files: { rules: { path, available: false } } };
  }
  if (text === RULES_TEMPLATE) return { files: { rules: { path, available: true, empty: true } } };
  return {
    files: { rules: { path, available: true } },
    rules: want ? ec.u.text(text, LIMITS.long, ['untrusted', 'rules']) : undefined,
  };
}

function finish<T extends ExplainPayload>(payload: T, rules: string | undefined, ec: EntryContext): ExplainResult {
  if (rules !== undefined) payload.untrusted = { rules };
  if (ec.findings.length > 0) payload.findings = ec.findings;
  if (ec.u.truncated.length > 0) payload.truncated = ec.u.truncated;
  if (ec.partial.value) payload.partial = true;
  return { payload, exitCode: ec.partial.value ? 2 : 0 };
}

/** Builds an explain response from local files only. Never connects to the database. */
export async function explain(root: string, req: ExplainRequest = {}): Promise<ExplainResult> {
  validateRequest(req);
  const fs = await ProjectFs.open(root);
  const { config, catalog } = await loadProject(fs);
  const pages = await readPages(fs, config);
  const all = subjects(config, catalog, pages);
  const ec: EntryContext = { u: new Untrusted(), findings: [], partial: { value: false } };

  if (JSON.stringify(config.schemas) !== JSON.stringify(catalog.schemas)) {
    ec.findings.push({ code: 'scope_mismatch', configured: config.schemas, snapshot: catalog.schemas });
  }
  const { files, rules } = await readRules(fs, config, req.rules ?? false, ec);
  const envelope: Envelope = {
    notice: NOTICE,
    source: { kind: 'local_snapshot', generatedAt: catalog.generatedAt, revision: catalog.revision },
    coverage: COVERAGE,
    contextFiles: files,
  };

  if (!req.tables || req.tables.length === 0) {
    const search = req.search?.trim().toLowerCase() ?? null;
    let active = catalog.relations.map((r) => all.get(r.id)!);
    const matched = new Map<string, string[]>();
    if (search !== null) {
      const ranked: { s: Subject; rank: number }[] = [];
      for (const s of active) {
        const rel = s.rel!;
        const names = [rel.name, `${rel.schema}.${rel.name}`, rel.id].map((n) => n.toLowerCase());
        const cols = rel.columns.map((c) => c.name).filter((c) => c.toLowerCase().includes(search));
        const rank = names.includes(search)
          ? 0
          : cols.some((c) => c.toLowerCase() === search)
            ? 1
            : cols.length > 0 || names.some((n) => n.includes(search))
              ? 2
              : -1;
        if (rank === -1) continue;
        ranked.push({ s, rank });
        if (cols.length > 0) matched.set(rel.id, cols);
      }
      ranked.sort((a, b) => a.rank - b.rank || compareStrings(a.s.id, b.s.id));
      active = ranked.map((r) => r.s);
    }
    const limit = req.limit ?? DEFAULT_LIMIT;
    const binding = cursorBinding(catalog.revision, search);
    const offset = req.cursor === undefined ? 0 : decodeCursor(req.cursor, binding, active.length);
    const slice = active.slice(offset, offset + limit);
    const key = search === null ? 'overview' : 'matches';
    const entries = slice.map((s, i) => {
      const e = summary(s, ec.u, [key, i]);
      const cols = matched.get(s.id);
      return cols ? { ...e, matchedCols: cols } : e;
    });
    const next = offset + limit < active.length ? encodeCursor(offset + limit, binding) : null;
    const page = { total: active.length, limit, nextCursor: next };
    const payload: DiscoveryPayload =
      search === null
        ? { ...envelope, page, overview: entries }
        : { ...envelope, search: req.search!.trim(), page, matches: entries };
    return finish(payload, rules, ec);
  }

  const requested = resolveNames(req.tables, config, all);
  if (requested.length > MAX_TABLES) {
    throw new TapuError(
      'too_many_relations',
      `At most ${MAX_TABLES} relations per request (got ${requested.length}). Split the request into smaller batches.`,
      { requested: requested.length, max: MAX_TABLES },
    );
  }

  const selection: Selection = { requested };
  let neighbors: string[] = [];
  if (req.related) {
    const wanted = new Set(requested);
    const found = new Set<string>();
    for (const id of requested) {
      const rel = all.get(id)!.rel;
      if (!rel) continue;
      for (const fk of rel.foreignKeys) if (all.get(fk.ref)?.rel && !wanted.has(fk.ref)) found.add(fk.ref);
      for (const r of rel.referencedBy) if (!wanted.has(r.from)) found.add(r.from);
    }
    const sorted = [...found].sort(compareStrings);
    neighbors = sorted.slice(0, MAX_NEIGHBORS);
    selection.neighbors = neighbors;
    selection.omittedNeighbors = sorted.length - neighbors.length;
  }

  const chosen = [...requested, ...neighbors].map((id) => all.get(id)!);
  const tables = chosen.map((s, i) => tableEntry(s, (req.notes ?? false) && i < requested.length, i, ec));

  const external = new Set<string>();
  const enumIds = new Set<string>();
  for (const s of chosen) {
    for (const fk of s.rel?.foreignKeys ?? []) if (!all.get(fk.ref)?.rel) external.add(fk.ref);
    for (const c of s.rel?.columns ?? []) if (c.enumType) enumIds.add(c.enumType);
  }
  if (external.size > 0) selection.external = [...external].sort(compareStrings);
  const enums: EnumEntry[] = catalog.enums
    .filter((e) => enumIds.has(e.id))
    .map((e) => (e.external ? { t: e.id, values: e.values, external: true } : { t: e.id, values: e.values }));

  const payload: DetailPayload = { ...envelope, selection, tables, ...(enums.length > 0 ? { enums } : {}) };
  return finish(payload, rules, ec);
}

// ---------------------------------------------------------------------------
// Human-readable output (same content; untrusted text grouped under "untrusted")

function untrustedLines(u: TableUntrusted | undefined, indent: string): string[] {
  if (!u) return [];
  const out = [`${indent}untrusted:`];
  const add = (label: string, text: string) => out.push(`${indent}  ${label}: ${text.replace(/\n/g, `\n${indent}    `)}`);
  if (u.purpose) add('purpose', u.purpose);
  if (u.owner) add('owner', u.owner);
  if (u.tags) add('tags', u.tags.join(', '));
  if (u.comment) add('comment', u.comment);
  for (const [col, text] of Object.entries(u.colComments ?? {})) add(`comment on ${col}`, text);
  for (const [col, text] of Object.entries(u.colNotes ?? {})) add(`note on ${col}`, text);
  if (u.notes) add('notes', u.notes);
  return out;
}

function warningLabel(w: Warning | Finding): string {
  const detail = Object.entries(w)
    .filter(([k]) => k !== 'code')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  return detail ? `${w.code} (${detail})` : w.code;
}

export function formatExplainHuman(p: ExplainPayload): string {
  const lines = [`Note: ${p.notice}`, `Source: local snapshot from ${p.source.generatedAt}, revision ${p.source.revision.slice(0, 12)} (${p.coverage}); not checked against the live database.`, ''];
  const rules = p.contextFiles.rules;
  if ('page' in p) {
    const entries = p.overview ?? p.matches ?? [];
    const what = p.search !== undefined ? `matches for "${p.search}"` : 'relations';
    lines.push(`${p.page.total} ${what} (showing ${entries.length}):`);
    for (const e of entries) {
      const meta = [e.kind, `${e.columns} columns`, e.warn ? `${e.warn} warnings` : undefined].filter(Boolean).join(', ');
      lines.push(`- ${e.t} (${meta})${e.matchedCols ? ` columns: ${e.matchedCols.join(', ')}` : ''}`);
      if (e.untrusted) lines.push(`    untrusted: purpose: ${e.untrusted.purpose}`);
    }
    if (p.page.nextCursor) lines.push(`More: --cursor ${p.page.nextCursor}`);
  } else {
    const sel = p.selection;
    if (sel.neighbors) {
      lines.push(`Neighbors: ${sel.neighbors.join(', ') || 'none'}${sel.omittedNeighbors ? ` (+${sel.omittedNeighbors} omitted)` : ''}`);
    }
    if (sel.external) lines.push(`Referenced but not captured: ${sel.external.join(', ')}`);
    if (sel.neighbors || sel.external) lines.push('');
    for (const t of p.tables) {
      const meta = [t.kind ?? t.state, t.rows !== undefined ? `~${t.rows} rows` : undefined].filter(Boolean).join(', ');
      lines.push(`${t.t} (${meta})`);
      const section = (label: string, items: string[] | undefined) => {
        if (items && items.length > 0) lines.push(`  ${label}:`, ...items.map((i) => `    ${i.replace(/\n/g, '\n    ')}`));
      };
      section('columns', t.cols);
      section('primary key', t.pk ? [t.pk] : undefined);
      section('unique', t.uniq);
      section('foreign keys', t.fk);
      section('referenced by', t.refBy);
      section('indexes', t.idx);
      section('checks', t.checks);
      section('view definition', t.view ? [t.view] : undefined);
      section('partition key', t.partitionKey ? [t.partitionKey] : undefined);
      section('warnings', t.warn?.map(warningLabel));
      if (t.contextFile) lines.push(`  context file: ${t.contextFile}`);
      lines.push(...untrustedLines(t.untrusted, '  '), '');
    }
    if (p.enums) {
      lines.push('Enums:');
      for (const e of p.enums) lines.push(`- ${e.t}${e.external ? ' (external)' : ''}: ${e.values.join(', ')}`);
    }
  }
  lines.push('', `Rules: ${rules.path} (${rules.available ? (rules.empty ? 'no conventions supplied' : 'available') : 'missing'})`);
  if (p.untrusted?.rules) lines.push('untrusted:', `  rules: ${p.untrusted.rules.replace(/\n/g, '\n    ')}`);
  if (p.findings) lines.push('Findings:', ...p.findings.map((f) => `- ${warningLabel(f)}`));
  if (p.truncated) lines.push(`Truncated fields (see the context files): ${p.truncated.join(', ')}`);
  if (p.partial) lines.push('Partial: requested context could not be read.');
  // Identifiers and prose can contain control characters; JSON escapes them, text must not carry them.
  return terminalSafe(lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')) + '\n';
}
