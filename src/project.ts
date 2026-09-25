import {
  CATALOG_FORMAT,
  COVERAGE,
  catalogRevision,
  type Catalog,
} from './catalog.js';
import { TapuError, errorMessage } from './errors.js';
import { ProjectFs, splitRelative } from './fsafe.js';

/** `.tapu/config.json`. Never contains a connection URL. */
export interface Config {
  version: 1;
  schemas: string[];
  wikiDir: string;
}

export const DEFAULT_CONFIG: Config = { version: 1, schemas: ['public'], wikiDir: 'db-wiki' };

export const CONFIG_PATH = '.tapu/config.json';
export const CATALOG_PATH = '.tapu/catalog.json';
export const AGENTS_PATH = 'AGENTS.md';

export interface WikiPaths {
  dir: string;
  tables: string;
  index: string;
  rules: string;
  log: string;
}

export function wikiPaths(config: Config): WikiPaths {
  const dir = config.wikiDir;
  return { dir, tables: `${dir}/tables`, index: `${dir}/index.md`, rules: `${dir}/rules.md`, log: `${dir}/log.md` };
}

function invalidConfig(reason: string): TapuError {
  return new TapuError('invalid_config', `${CONFIG_PATH}: ${reason}`, { file: CONFIG_PATH });
}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidConfig('not a JSON object');
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw invalidConfig(`unsupported version ${JSON.stringify(v.version)}`);
  const schemas = v.schemas;
  if (
    !Array.isArray(schemas) ||
    schemas.length === 0 ||
    !schemas.every((s) => typeof s === 'string' && s !== '' && !s.includes('\0'))
  ) {
    throw invalidConfig('"schemas" must be a non-empty array of schema names');
  }
  if (new Set(schemas).size !== schemas.length) throw invalidConfig('"schemas" contains duplicates');
  const wikiDir = v.wikiDir;
  let ok = typeof wikiDir === 'string';
  if (ok) {
    try {
      const parts = splitRelative(wikiDir as string);
      ok = parts[0] !== '.tapu';
    } catch {
      ok = false;
    }
  }
  if (!ok) throw invalidConfig('"wikiDir" must be a relative path inside the project, without "." or ".." segments');
  return { version: 1, schemas: schemas as string[], wikiDir: wikiDir as string };
}

export async function loadConfig(fs: ProjectFs): Promise<Config | null> {
  const text = await fs.read(CONFIG_PATH);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw invalidConfig(`not valid JSON (${errorMessage(err)})`);
  }
  return validateConfig(value);
}

export async function saveConfig(fs: ProjectFs, config: Config): Promise<boolean> {
  const current = await fs.read(CONFIG_PATH);
  if (current !== null) {
    try {
      const existing = validateConfig(JSON.parse(current));
      if (JSON.stringify(existing) === JSON.stringify(config)) return false; // keep formatting and unknown keys
    } catch {
      // rewritten below
    }
  }
  return fs.write(CONFIG_PATH, JSON.stringify(config) + '\n');
}

function invalidCatalog(reason: string): TapuError {
  return new TapuError('invalid_catalog', `${CATALOG_PATH}: ${reason}. Run \`tapu init\` to regenerate it.`, {
    file: CATALOG_PATH,
    next: 'tapu init',
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shape checks plus a revision check, so a hand-edited or truncated catalog is not trusted. */
export function validateCatalog(value: unknown): Catalog {
  if (!isObject(value)) throw invalidCatalog('not a JSON object');
  if (value.format !== CATALOG_FORMAT) throw invalidCatalog(`unsupported format ${JSON.stringify(value.format)}`);
  if (value.coverage !== COVERAGE) throw invalidCatalog(`unsupported coverage ${JSON.stringify(value.coverage)}`);
  if (typeof value.generatedAt !== 'string') throw invalidCatalog('missing generatedAt');
  if (!Array.isArray(value.schemas) || !value.schemas.every((s) => typeof s === 'string')) {
    throw invalidCatalog('invalid schemas');
  }
  const rels = value.relations;
  if (
    !Array.isArray(rels) ||
    !rels.every(
      (r) =>
        isObject(r) &&
        typeof r.id === 'string' &&
        typeof r.schema === 'string' &&
        typeof r.name === 'string' &&
        typeof r.kind === 'string' &&
        Array.isArray(r.columns) &&
        Array.isArray(r.uniques) &&
        Array.isArray(r.checks) &&
        Array.isArray(r.foreignKeys) &&
        Array.isArray(r.indexes) &&
        Array.isArray(r.referencedBy) &&
        typeof r.hash === 'string' &&
        typeof r.docHash === 'string',
    )
  ) {
    throw invalidCatalog('invalid relations');
  }
  const enums = value.enums;
  if (
    !Array.isArray(enums) ||
    !enums.every((e) => isObject(e) && typeof e.id === 'string' && Array.isArray(e.values) && typeof e.hash === 'string')
  ) {
    throw invalidCatalog('invalid enums');
  }
  const catalog = value as unknown as Catalog;
  if (catalog.revision !== catalogRevision(catalog)) throw invalidCatalog('revision does not match its content');
  return catalog;
}

export async function loadCatalog(fs: ProjectFs): Promise<Catalog | null> {
  const text = await fs.read(CATALOG_PATH);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw invalidCatalog(`not valid JSON (${errorMessage(err)})`);
  }
  return validateCatalog(value);
}

export async function saveCatalog(fs: ProjectFs, catalog: Catalog): Promise<boolean> {
  return fs.write(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
}

/** Config and catalog for the read-only commands; fails with a hint when init never ran. */
export async function loadProject(fs: ProjectFs): Promise<{ config: Config; catalog: Catalog }> {
  const config = await loadConfig(fs);
  const catalog = config ? await loadCatalog(fs) : null;
  if (!config || !catalog) {
    throw new TapuError('not_initialized', 'No Tapu catalog found in this project. Run `tapu init` first.', {
      next: 'tapu init',
    });
  }
  return { config, catalog };
}
