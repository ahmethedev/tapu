import type { Catalog } from './catalog.js';
import { withSession } from './db.js';
import { introspect } from './introspect.js';
import { loadProject, type Config } from './project.js';
import { sanitizeUntrusted } from './sanitize.js';
import { staleNotes } from './warnings.js';
import { pageRelPath, readPages, type PageFile } from './wiki.js';

export interface StatusReport {
  /** True when nothing below is non-empty. */
  clean: boolean;
  schemas: string[];
  /** Live relations missing from the catalog. */
  added: string[];
  /** Catalog relations gone from the database. */
  removed: string[];
  /** Live relations whose structural hash differs from the catalog or from their page. */
  changed: string[];
  pages: {
    /** Live relations without a page. */
    missing: string[];
    /** Pages whose relation is gone from the database. */
    removed: string[];
    /** Pages whose frontmatter or tapu:auto markers cannot be parsed. */
    broken: { file: string; reason: string }[];
  };
  /** Frontmatter column entries for columns that no longer exist. */
  staleNotes: { t: string; col: string }[];
}

/** Compares a live catalog with the stored catalog and the wiki pages. Pure: no I/O. */
export function compareStatus(
  config: Config,
  stored: Catalog,
  live: Catalog,
  pages: Map<string, PageFile>,
): StatusReport {
  const storedHashes = new Map(stored.relations.map((r) => [r.id, r.hash]));
  const liveIds = new Set(live.relations.map((r) => r.id));
  const report: StatusReport = {
    clean: true,
    schemas: config.schemas,
    added: [],
    removed: stored.relations.map((r) => r.id).filter((id) => !liveIds.has(id)),
    changed: [],
    pages: { missing: [], removed: [], broken: [] },
    staleNotes: [],
  };

  for (const rel of live.relations) {
    const storedHash = storedHashes.get(rel.id);
    const page = pages.get(rel.id);
    const parsed = page?.parse.ok ? page.parse.page : null;
    if (storedHash === undefined) report.added.push(rel.id);
    const catalogDiffers = storedHash !== undefined && storedHash !== rel.hash;
    const pageDiffers = parsed !== null && parsed.hash !== rel.hash;
    if (catalogDiffers || (storedHash !== undefined && pageDiffers)) report.changed.push(rel.id);
    if (!page) report.pages.missing.push(rel.id);
    if (parsed) {
      for (const col of staleNotes(rel, parsed.front)) {
        report.staleNotes.push({ t: rel.id, col: sanitizeUntrusted(col, 64) });
      }
    }
  }

  for (const page of pages.values()) {
    if (!liveIds.has(page.id)) report.pages.removed.push(page.id);
    if (!page.parse.ok) report.pages.broken.push({ file: pageRelPath(config, page.file), reason: page.parse.reason });
  }

  report.clean =
    report.added.length === 0 &&
    report.removed.length === 0 &&
    report.changed.length === 0 &&
    report.pages.missing.length === 0 &&
    report.pages.removed.length === 0 &&
    report.pages.broken.length === 0 &&
    report.staleNotes.length === 0;
  return report;
}

/** Connects (read-only, metadata only), introspects and compares. */
export async function runStatus(root: string, url: string): Promise<StatusReport> {
  const { config, catalog } = await loadProject(root);
  const live = await withSession(url, (session) => introspect(session, config.schemas));
  const pages = await readPages(root, config);
  return compareStatus(config, catalog, live, pages);
}

export function statusExitCode(report: StatusReport): 0 | 1 {
  return report.clean ? 0 : 1;
}

export function formatStatusHuman(report: StatusReport): string {
  if (report.clean) return `Tapu status: clean (schemas: ${report.schemas.join(', ')})\n`;
  const lines = [`Tapu status: drift detected (schemas: ${report.schemas.join(', ')})`];
  const add = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`  ${label}: ${items.join(', ')}`);
  };
  add('added relations', report.added);
  add('removed relations', report.removed);
  add('changed relations', report.changed);
  add('missing pages', report.pages.missing);
  add('pages of removed relations', report.pages.removed);
  add('broken pages', report.pages.broken.map((b) => `${b.file} (${b.reason})`));
  add('stale column notes', report.staleNotes.map((s) => `${s.t}.${s.col}`));
  lines.push('Run `tapu init` to refresh the catalog and wiki; fix broken pages, stale notes and removed pages by hand.');
  return lines.join('\n') + '\n';
}
