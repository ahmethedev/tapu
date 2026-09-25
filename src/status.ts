import {
  COVERAGE,
  COVERAGE_LIMITS,
  catalogRevision,
  compareStrings,
  structuralSections,
  type Catalog,
  type EnumType,
  type Relation,
} from './catalog.js';
import { withSession } from './db.js';
import { TapuError, errorMessage } from './errors.js';
import { ProjectFs } from './fsafe.js';
import { introspect } from './introspect.js';
import { loadProject, wikiPaths, type Config } from './project.js';
import { LIMITS, clip, cleanText, terminalSafe } from './sanitize.js';
import { relationWarnings, staleNotes } from './warnings.js';
import { readPages, type PageFile, type PageState } from './wiki.js';

/** Actionable synchronization findings (exit 1). */
export type StatusFinding =
  | { code: 'relation_added'; t: string }
  | { code: 'relation_removed'; t: string }
  | { code: 'relation_changed'; t: string; sections: string[] }
  | { code: 'relation_documentation_changed'; t: string; table?: true; columns?: string[] }
  | { code: 'enum_added'; t: string }
  | { code: 'enum_removed'; t: string }
  | { code: 'enum_changed'; t: string }
  | { code: 'page_missing'; t: string }
  | { code: 'page_structure_mismatch'; t: string; file: string }
  | { code: 'page_documentation_mismatch'; t: string; file: string }
  | { code: 'page_not_archived'; t: string; file: string }
  | { code: 'page_archived_but_present'; t: string; file: string; pageState: PageState }
  | { code: 'stale_note'; t: string; column: string; file: string }
  | { code: 'scope_changed'; configured: string[]; snapshot: string[] }
  | { code: 'index_missing'; file: string };

/** Local context that prevents a reliable comparison (exit 2). */
export type StatusError = { code: 'page_invalid'; t: string; file: string; reason: string };

export type Advisory =
  | { code: 'no_primary_key'; t: string }
  | { code: 'fk_without_index'; t: string; columns: string[] }
  | { code: 'undocumented'; t: string }
  | { code: 'rules_missing'; file: string }
  | { code: 'log_missing'; file: string };

export interface StatusReport {
  checkedAt: string;
  /** `synchronized` (exit 0), `out_of_sync` (exit 1) or `error` (exit 2). */
  result: 'synchronized' | 'out_of_sync' | 'error';
  schemas: string[];
  coverage: typeof COVERAGE;
  /** Metadata this comparison does not cover; a clean result is clean within the coverage only. */
  notCovered: readonly string[];
  snapshot: { generatedAt: string; revision: string };
  live: { revision: string };
  findings: StatusFinding[];
  errors: StatusError[];
  /** Pages kept for removed or out-of-scope relations (informational). */
  archived: { t: string; state: Exclude<PageState, 'active'>; file: string }[];
  advisories: Advisory[];
}

export interface Artifacts {
  index: boolean;
  rules: boolean;
  log: boolean;
}

const SECTION_ORDER = ['kind', 'columns', 'primaryKey', 'uniques', 'checks', 'foreignKeys', 'indexes', 'view', 'partitionKey', 'enums'];

function changedSections(a: Relation, b: Relation, aEnums: Map<string, EnumType>, bEnums: Map<string, EnumType>): string[] {
  const sa = structuralSections(a, aEnums);
  const sb = structuralSections(b, bEnums);
  return SECTION_ORDER.filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
}

/** Column names from human frontmatter are sanitized before they appear in output. */
function safeName(name: string): string {
  return clip(cleanText(name), LIMITS.field).text;
}

/** Compares live metadata with the saved catalog and with the pages. Pure: no I/O. */
export function compareStatus(
  config: Config,
  stored: Catalog,
  live: Catalog,
  pages: Map<string, PageFile>,
  artifacts: Artifacts,
  now: Date = new Date(),
): StatusReport {
  const report: StatusReport = {
    checkedAt: now.toISOString(),
    result: 'synchronized',
    schemas: config.schemas,
    coverage: COVERAGE,
    notCovered: COVERAGE_LIMITS,
    snapshot: { generatedAt: stored.generatedAt, revision: stored.revision },
    live: { revision: catalogRevision(live) },
    findings: [],
    errors: [],
    archived: [],
    advisories: [],
  };
  const f = report.findings;
  const paths = wikiPaths(config);

  if (JSON.stringify(config.schemas) !== JSON.stringify(stored.schemas)) {
    f.push({ code: 'scope_changed', configured: config.schemas, snapshot: stored.schemas });
  }

  // 1. Live database vs saved catalog (within the configured schemas).
  const inScope = new Set(config.schemas);
  const storedRels = new Map(stored.relations.filter((r) => inScope.has(r.schema)).map((r) => [r.id, r]));
  const liveRels = new Map(live.relations.map((r) => [r.id, r]));
  const storedEnums = new Map(stored.enums.map((e) => [e.id, e]));
  const liveEnums = new Map(live.enums.map((e) => [e.id, e]));
  for (const rel of live.relations) {
    const old = storedRels.get(rel.id);
    if (!old) {
      f.push({ code: 'relation_added', t: rel.id });
      continue;
    }
    if (old.hash !== rel.hash) {
      f.push({ code: 'relation_changed', t: rel.id, sections: changedSections(old, rel, storedEnums, liveEnums) });
    }
    const oldComments = new Map(old.columns.map((c) => [c.name, c.comment]));
    const columns = rel.columns
      .filter((c) => oldComments.has(c.name) && oldComments.get(c.name) !== c.comment)
      .map((c) => c.name);
    if (old.comment !== rel.comment || columns.length > 0) {
      f.push({
        code: 'relation_documentation_changed',
        t: rel.id,
        ...(old.comment !== rel.comment ? { table: true as const } : {}),
        ...(columns.length > 0 ? { columns } : {}),
      });
    }
  }
  for (const id of storedRels.keys()) if (!liveRels.has(id)) f.push({ code: 'relation_removed', t: id });
  for (const e of live.enums) {
    const old = storedEnums.get(e.id);
    if (!old) f.push({ code: 'enum_added', t: e.id });
    else if (old.hash !== e.hash) f.push({ code: 'enum_changed', t: e.id });
  }
  for (const e of stored.enums) {
    if (!liveEnums.has(e.id) && (e.external || inScope.has(e.schema))) f.push({ code: 'enum_removed', t: e.id });
  }

  // 2. Live database vs page hashes (independent of the catalog).
  for (const rel of live.relations) {
    const page = pages.get(rel.id);
    if (!page) {
      f.push({ code: 'page_missing', t: rel.id });
      continue;
    }
    if (!page.parse.ok) {
      report.errors.push({ code: 'page_invalid', t: rel.id, file: page.path, reason: page.parse.reason });
      continue;
    }
    const p = page.parse.page;
    if (p.state !== 'active') f.push({ code: 'page_archived_but_present', t: rel.id, file: page.path, pageState: p.state });
    else if (p.hash !== rel.hash) f.push({ code: 'page_structure_mismatch', t: rel.id, file: page.path });
    else if (p.docHash !== rel.docHash) f.push({ code: 'page_documentation_mismatch', t: rel.id, file: page.path });
    for (const column of staleNotes(rel, p.front)) {
      f.push({ code: 'stale_note', t: rel.id, column: safeName(column), file: page.path });
    }
    for (const w of relationWarnings(rel, p.front)) {
      if (w.code === 'no_primary_key' || w.code === 'undocumented') report.advisories.push({ code: w.code, t: rel.id });
      if (w.code === 'fk_without_index') report.advisories.push({ code: w.code, t: rel.id, columns: w.columns });
    }
  }
  for (const page of pages.values()) {
    if (liveRels.has(page.id)) continue;
    if (!page.parse.ok) {
      report.errors.push({ code: 'page_invalid', t: page.id, file: page.path, reason: page.parse.reason });
      continue;
    }
    const state = page.parse.page.state;
    if (state === 'active') f.push({ code: 'page_not_archived', t: page.id, file: page.path });
    else report.archived.push({ t: page.id, state, file: page.path });
  }

  if (!artifacts.index) f.push({ code: 'index_missing', file: paths.index });
  if (!artifacts.rules) report.advisories.push({ code: 'rules_missing', file: paths.rules });
  if (!artifacts.log) report.advisories.push({ code: 'log_missing', file: paths.log });

  const byT = (a: { t?: string }, b: { t?: string }) => compareStrings(a.t ?? '', b.t ?? '');
  report.errors.sort(byT);
  report.archived.sort(byT);
  report.result = report.errors.length > 0 ? 'error' : f.length > 0 ? 'out_of_sync' : 'synchronized';
  return report;
}

/** Reads local artifacts, then connects (read-only, metadata only), introspects and compares. */
export async function runStatus(root: string, url: string, now: Date = new Date()): Promise<StatusReport> {
  const fs = await ProjectFs.open(root);
  const { config, catalog } = await loadProject(fs);
  const pages = await readPages(fs, config);
  const paths = wikiPaths(config);
  const exists = async (path: string) => {
    try {
      return await fs.exists(path);
    } catch (err) {
      throw err instanceof TapuError ? err : new TapuError('io_error', `${path}: ${errorMessage(err)}`);
    }
  };
  const artifacts = { index: await exists(paths.index), rules: await exists(paths.rules), log: await exists(paths.log) };
  const live = await withSession(url, (session) => introspect(session, config.schemas, now));
  return compareStatus(config, catalog, live, pages, artifacts, now);
}

export function statusExitCode(report: StatusReport): 0 | 1 | 2 {
  return report.result === 'error' ? 2 : report.result === 'out_of_sync' ? 1 : 0;
}

function describe(item: Record<string, unknown>): string {
  const { code, t, ...rest } = item;
  const detail = Object.entries(rest)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  return [code, t, detail].filter((x) => x !== undefined && x !== '').join(' ');
}

export function formatStatusHuman(report: StatusReport): string {
  const label = { synchronized: 'synchronized', out_of_sync: 'out of sync', error: 'error' }[report.result];
  const lines = [
    `Tapu status: ${label} (schemas: ${report.schemas.join(', ')}; coverage ${report.coverage}; checked ${report.checkedAt})`,
  ];
  const group = (title: string, items: object[]) => {
    if (items.length > 0) lines.push(`${title}:`, ...items.map((i) => `  - ${describe(i as Record<string, unknown>)}`));
  };
  group('Errors (comparison not reliable)', report.errors);
  group('Findings', report.findings);
  group('Archived pages', report.archived);
  group('Advisories', report.advisories);
  if (report.result !== 'synchronized') {
    lines.push('Run `tapu init` to refresh the catalog and pages. Fix invalid pages and stale column notes by hand.');
  }
  lines.push(`Not covered: ${report.notCovered.join('; ')}.`);
  return terminalSafe(lines.join('\n')) + '\n';
}
