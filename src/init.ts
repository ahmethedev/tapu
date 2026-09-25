import type { Catalog } from './catalog.js';
import { withSession } from './db.js';
import { TapuError, errorMessage } from './errors.js';
import { ProjectFs } from './fsafe.js';
import { pageFileName } from './ident.js';
import { introspect } from './introspect.js';
import {
  AGENTS_PATH,
  CATALOG_PATH,
  DEFAULT_CONFIG,
  loadCatalog,
  loadConfig,
  saveCatalog,
  saveConfig,
  wikiPaths,
  type Config,
} from './project.js';
import {
  AGENTS_PARAGRAPH,
  RULES_TEMPLATE,
  archivePage,
  pageFront,
  readPages,
  renderContext,
  renderIndex,
  renderNewPage,
  updatePage,
  type IndexEntry,
  type PageState,
} from './wiki.js';

export interface InitOptions {
  root: string;
  url: string;
  /** Explicit schema selection; saved to config. */
  schemas?: string[];
  writeAgents?: boolean;
  now?: Date;
}

export interface Skipped {
  file: string;
  reason: string;
}

export interface InitResult {
  config: Config;
  relations: number;
  enums: number;
  /** Relation changes since the previous catalog (empty on a first run). */
  added: string[];
  changed: string[];
  removed: string[];
  pages: {
    created: string[];
    updated: string[];
    removed: string[];
    outOfScope: string[];
    skipped: Skipped[];
  };
  /** Active relations with neither a purpose nor a DB comment. */
  undocumented: number;
  /** `written`: appended now; `present`: already there; `skipped`: --write-agents not given; `failed`: see pages.skipped. */
  agents: 'written' | 'present' | 'skipped' | 'failed';
  /** Some pages or artifacts could not be written; the catalog was still refreshed. */
  partial: boolean;
}

/** `2026-09-25T10:30:00Z` (no milliseconds). */
export function logTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function reasonOf(err: unknown): string {
  return err instanceof TapuError ? err.message : errorMessage(err);
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const now = opts.now ?? new Date();
  const fs = await ProjectFs.open(opts.root);

  // Everything that can be checked before connecting is checked first, so a
  // failure leaves all existing artifacts unchanged.
  const existing = await loadConfig(fs);
  const config: Config = { ...(existing ?? DEFAULT_CONFIG), ...(opts.schemas?.length ? { schemas: opts.schemas } : {}) };
  const paths = wikiPaths(config);
  for (const p of ['.tapu', paths.dir, paths.tables, CATALOG_PATH, paths.index, paths.rules, paths.log]) {
    await fs.resolve(p);
  }

  const catalog = await withSession(opts.url, (session) => introspect(session, config.schemas, now));

  let previous: Catalog | null = null;
  try {
    previous = await loadCatalog(fs);
  } catch {
    previous = null; // machine-owned; regenerated below
  }
  const prev = new Map((previous?.relations ?? []).map((r) => [r.id, r.hash]));
  const live = new Map(catalog.relations.map((r) => [r.id, r.hash]));
  const added = previous ? [...live.keys()].filter((id) => !prev.has(id)) : [];
  const changed = [...live.keys()].filter((id) => prev.has(id) && prev.get(id) !== live.get(id));
  const removed = [...prev.keys()].filter((id) => !live.has(id));

  const result: InitResult = {
    config,
    relations: catalog.relations.length,
    enums: catalog.enums.length,
    added,
    changed,
    removed,
    pages: { created: [], updated: [], removed: [], outOfScope: [], skipped: [] },
    undocumented: 0,
    agents: 'skipped',
    partial: false,
  };
  const skip = (file: string, reason: string) => result.pages.skipped.push({ file, reason });

  // Pages. Each page is written atomically; the refresh as a whole is not.
  const pages = await readPages(fs, config);
  const ctx = renderContext(catalog);
  const index: IndexEntry[] = [];
  for (const rel of catalog.relations) {
    const page = pages.get(rel.id);
    const front = pageFront(page);
    const purpose = front?.purpose.trim() || rel.comment?.trim() || '';
    if (!purpose) result.undocumented++;
    index.push({ id: rel.id, schema: rel.schema, name: rel.name, kind: rel.kind, purpose, state: 'active' });
    try {
      if (!page) {
        await fs.write(`${paths.tables}/${pageFileName(rel.schema, rel.name)}`, renderNewPage(rel, ctx));
        result.pages.created.push(rel.id);
        continue;
      }
      if (page.text === null || !page.parse.ok) {
        skip(page.path, page.parse.ok ? 'cannot be read' : page.parse.reason);
        continue;
      }
      const update = updatePage(page.text, rel, ctx);
      if (!update.ok) {
        skip(page.path, update.reason);
        continue;
      }
      if (await fs.write(page.path, update.text)) result.pages.updated.push(rel.id);
    } catch (err) {
      skip(page?.path ?? `${paths.tables}/${pageFileName(rel.schema, rel.name)}`, reasonOf(err));
    }
  }

  const inScope = new Set(config.schemas);
  for (const page of pages.values()) {
    if (live.has(page.id)) continue;
    const state: PageState = inScope.has(page.schema) ? 'removed' : 'out_of_scope';
    index.push({ id: page.id, schema: page.schema, name: page.name, state });
    if (page.text === null || !page.parse.ok) {
      skip(page.path, page.parse.ok ? 'cannot be read' : page.parse.reason);
      continue;
    }
    const update = archivePage(page.text, page.id, state);
    if (!update.ok) {
      skip(page.path, update.reason);
      continue;
    }
    try {
      if (await fs.write(page.path, update.text)) {
        (state === 'removed' ? result.pages.removed : result.pages.outOfScope).push(page.id);
      }
    } catch (err) {
      skip(page.path, reasonOf(err));
    }
  }

  const artifact = async (path: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (err) {
      skip(path, reasonOf(err));
    }
  };
  index.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await artifact(paths.index, () => fs.write(paths.index, renderIndex(index)));
  await artifact(paths.rules, async () => {
    if (!(await fs.exists(paths.rules))) await fs.write(paths.rules, RULES_TEMPLATE);
  });

  // The machine catalog is refreshed even when some pages were skipped, so
  // status can see the page-vs-catalog differences.
  await saveConfig(fs, config);
  await saveCatalog(fs, catalog);

  if (opts.writeAgents) {
    result.agents = 'failed';
    await artifact(AGENTS_PATH, async () => {
      const text = (await fs.read(AGENTS_PATH)) ?? '';
      if (text.includes(AGENTS_PARAGRAPH)) {
        result.agents = 'present';
      } else {
        const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
        await fs.write(AGENTS_PATH, text + sep + AGENTS_PARAGRAPH + '\n');
        result.agents = 'written';
      }
    });
  }

  const p = result.pages;
  await artifact(paths.log, async () => {
    const log = (await fs.read(paths.log)) ?? '# Tapu log\n\n';
    const line =
      `${logTimestamp(now)} init: ${result.relations} relations, ${result.enums} enums; pages: ` +
      `${p.created.length} new, ${p.updated.length} changed, ${p.removed.length} removed, ` +
      `${p.outOfScope.length} out of scope, ${p.skipped.length} skipped\n`;
    await fs.write(paths.log, log + line);
  });

  result.partial = p.skipped.length > 0;
  return result;
}

export function formatInitSummary(result: InitResult, redactedUrl: string): string {
  const p = result.pages;
  const lines = [
    `Introspected ${redactedUrl} (schemas: ${result.config.schemas.join(', ')})`,
    `${result.relations} relations, ${result.enums} enums` +
      (result.added.length + result.changed.length + result.removed.length > 0
        ? ` (since the last snapshot: ${result.added.length} added, ${result.changed.length} changed, ${result.removed.length} removed)`
        : ''),
    `Pages: ${p.created.length} created, ${p.updated.length} updated, ${p.removed.length} archived as removed, ` +
      `${p.outOfScope.length} archived as out of scope, ${p.skipped.length} skipped`,
    `${result.undocumented} of ${result.relations} active relations have no purpose and no DB comment (optional; agents can use the schema without them).`,
  ];
  for (const s of p.skipped) lines.push(`Skipped ${s.file}: ${s.reason}. It was left unchanged; fix it by hand.`);
  if (result.partial) lines.push('Partial refresh: the catalog was updated, but the files above were not.');
  lines.push('');
  lines.push(
    {
      written: 'Added this paragraph to AGENTS.md:',
      present: 'AGENTS.md already contains:',
      skipped: 'Optional: add this paragraph to AGENTS.md (or run init with --write-agents):',
      failed: 'Could not update AGENTS.md; the paragraph is:',
    }[result.agents],
  );
  lines.push('', AGENTS_PARAGRAPH);
  return lines.join('\n');
}
