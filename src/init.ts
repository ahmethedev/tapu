import { appendFile } from 'node:fs/promises';
import type { Catalog } from './catalog.js';
import { withSession } from './db.js';
import { introspect } from './introspect.js';
import {
  DEFAULT_CONFIG,
  loadCatalog,
  loadConfig,
  projectPaths,
  readTextIfExists,
  saveCatalog,
  saveConfig,
  writeIfChanged,
  type Config,
} from './project.js';
import { AGENTS_LINE, readPages, writeWiki, type WikiResult } from './wiki.js';

export interface InitOptions {
  root: string;
  url: string;
  /** Overrides (and saves) the configured schemas. */
  schemas?: string[];
  writeAgents?: boolean;
  now?: Date;
}

export interface InitResult {
  config: Config;
  relations: number;
  added: string[];
  changed: string[];
  removed: string[];
  wiki: WikiResult;
  /** `written`: appended now; `present`: already there; `skipped`: --write-agents not given. */
  agents: 'written' | 'present' | 'skipped';
}

/** `2026-09-25T10:30:00Z` (no milliseconds). */
export function logTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Hashes from the previous run: the previous catalog if there is one,
 * otherwise the hashes recorded in existing (non-removed) pages.
 */
async function previousHashes(root: string, config: Config, previous: Catalog | null): Promise<Map<string, string>> {
  if (previous) return new Map(previous.relations.map((r) => [r.id, r.hash]));
  const out = new Map<string, string>();
  for (const page of (await readPages(root, config)).values()) {
    if (page.parse.ok && page.parse.page.front.status !== 'removed') out.set(page.id, page.parse.page.hash ?? '');
  }
  return out;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const now = opts.now ?? new Date();
  const existing = await loadConfig(opts.root);
  const config: Config = { ...(existing ?? DEFAULT_CONFIG), ...(opts.schemas?.length ? { schemas: opts.schemas } : {}) };

  const catalog = await withSession(opts.url, (session) => introspect(session, config.schemas, now));

  let previous: Catalog | null = null;
  try {
    previous = await loadCatalog(opts.root);
  } catch {
    previous = null; // unreadable or old catalog: it is machine-owned and regenerated below
  }
  const prev = await previousHashes(opts.root, config, previous);
  const live = new Map(catalog.relations.map((r) => [r.id, r.hash]));
  const added = [...live.keys()].filter((id) => !prev.has(id));
  const changed = [...live.keys()].filter((id) => prev.has(id) && prev.get(id) !== live.get(id));
  const removed = [...prev.keys()].filter((id) => !live.has(id));

  await saveConfig(opts.root, config);
  const wiki = await writeWiki(opts.root, config, catalog);
  await saveCatalog(opts.root, catalog);

  const paths = projectPaths(opts.root, config);
  if ((await readTextIfExists(paths.log)) === null) await writeIfChanged(paths.log, '# Tapu log\n\n');
  await appendFile(
    paths.log,
    `${logTimestamp(now)} init: ${catalog.relations.length} tables, ${added.length} new, ${changed.length} changed, ${removed.length} removed\n`,
  );

  let agents: InitResult['agents'] = 'skipped';
  if (opts.writeAgents) {
    const text = (await readTextIfExists(paths.agents)) ?? '';
    if (text.includes(AGENTS_LINE)) {
      agents = 'present';
    } else {
      const sep = text === '' || text.endsWith('\n') ? '' : '\n';
      await writeIfChanged(paths.agents, text + sep + AGENTS_LINE + '\n');
      agents = 'written';
    }
  }

  return { config, relations: catalog.relations.length, added, changed, removed, wiki, agents };
}

export function formatInitSummary(result: InitResult, redactedUrl: string): string {
  const lines = [
    `Introspected ${redactedUrl} (schemas: ${result.config.schemas.join(', ')})`,
    `${result.relations} relations: ${result.added.length} new, ${result.changed.length} changed, ${result.removed.length} removed`,
    `Wrote .tapu/catalog.json and ${result.config.wikiDir}/ (${result.wiki.created.length} pages created, ${result.wiki.updated.length} updated, ${result.wiki.markedRemoved.length} marked removed)`,
  ];
  for (const s of result.wiki.skipped) lines.push(`Skipped ${s.file}: ${s.reason} (fix the page by hand; it was not modified)`);
  lines.push('');
  lines.push(
    {
      written: 'Added this line to AGENTS.md:',
      present: 'AGENTS.md already contains:',
      skipped: 'Add this line to AGENTS.md (or run with --write-agents):',
    }[result.agents],
  );
  lines.push(`  ${AGENTS_LINE}`);
  return lines.join('\n');
}
