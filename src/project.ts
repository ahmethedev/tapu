import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { CATALOG_VERSION, type Catalog } from './catalog.js';

/** `.tapu/config.json`. Never contains a connection URL. */
export interface Config {
  version: 1;
  schemas: string[];
  wikiDir: string;
}

export const DEFAULT_CONFIG: Config = { version: 1, schemas: ['public'], wikiDir: 'db-wiki' };

export interface Paths {
  tapuDir: string;
  config: string;
  catalog: string;
  wikiDir: string;
  tablesDir: string;
  index: string;
  rules: string;
  log: string;
  agents: string;
}

export function projectPaths(root: string, config: Config = DEFAULT_CONFIG): Paths {
  const tapuDir = join(root, '.tapu');
  const wikiDir = join(root, config.wikiDir);
  return {
    tapuDir,
    config: join(tapuDir, 'config.json'),
    catalog: join(tapuDir, 'catalog.json'),
    wikiDir,
    tablesDir: join(wikiDir, 'tables'),
    index: join(wikiDir, 'index.md'),
    rules: join(wikiDir, 'rules.md'),
    log: join(wikiDir, 'log.md'),
    agents: join(root, 'AGENTS.md'),
  };
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes a file (creating parent directories) unless it already has exactly this content. */
export async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if ((await readTextIfExists(path)) === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return true;
}

function validateConfig(value: unknown): Config {
  const v = value as Partial<Config> | null;
  if (!v || typeof v !== 'object') throw new Error('.tapu/config.json is not an object');
  if (v.version !== 1) throw new Error(`.tapu/config.json: unsupported version ${String(v.version)}`);
  if (!Array.isArray(v.schemas) || v.schemas.length === 0 || !v.schemas.every((s) => typeof s === 'string' && s)) {
    throw new Error('.tapu/config.json: "schemas" must be a non-empty array of schema names');
  }
  if (typeof v.wikiDir !== 'string' || !v.wikiDir || isAbsolute(v.wikiDir) || normalize(v.wikiDir).startsWith('..')) {
    throw new Error('.tapu/config.json: "wikiDir" must be a relative path inside the project');
  }
  return { version: 1, schemas: v.schemas, wikiDir: v.wikiDir };
}

export async function loadConfig(root: string): Promise<Config | null> {
  const text = await readTextIfExists(projectPaths(root).config);
  if (text === null) return null;
  return validateConfig(JSON.parse(text));
}

export async function saveConfig(root: string, config: Config): Promise<void> {
  await writeIfChanged(projectPaths(root).config, JSON.stringify(config, null, 2) + '\n');
}

export async function loadCatalog(root: string): Promise<Catalog | null> {
  const text = await readTextIfExists(projectPaths(root).catalog);
  if (text === null) return null;
  const catalog = JSON.parse(text) as Catalog;
  if (catalog.version !== CATALOG_VERSION) {
    throw new Error(`.tapu/catalog.json: unsupported version ${String(catalog.version)}; run \`tapu init\``);
  }
  return catalog;
}

export async function saveCatalog(root: string, catalog: Catalog): Promise<void> {
  await writeIfChanged(projectPaths(root).catalog, JSON.stringify(catalog, null, 2) + '\n');
}

/** Loads config and catalog for the read-only commands; fails with a hint when `init` never ran. */
export async function loadProject(root: string): Promise<{ config: Config; catalog: Catalog }> {
  const config = await loadConfig(root);
  const catalog = await loadCatalog(root);
  if (!config || !catalog) throw new Error('No Tapu catalog found in this directory. Run `tapu init` first.');
  return { config, catalog };
}
