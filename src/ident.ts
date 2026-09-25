import { createHash } from 'node:crypto';

// PostgreSQL identifiers. Names are kept exactly as the catalog stores them;
// the canonical qualified ID quotes a part whenever it is not a plain
// lower-case identifier, so `"a.b".c` and `a."b.c"` never collide.

const PLAIN = /^[a-z_][a-z0-9_]*$/;

export function quoteIdent(name: string): string {
  return PLAIN.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Canonical qualified ID for display and identity, e.g. `public.orders` or `"Sales"."Q1 totals"`. */
export function qualifiedId(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Parses `name`, `schema.name`, `"Quoted.Name"` or `"My Schema"."Orders"`.
 * As in PostgreSQL, unquoted parts fold ASCII letters to lower case and `""`
 * inside quotes is a literal quote. Returns null for anything malformed,
 * including more than two parts.
 */
export function parseQualifiedName(input: string): string[] | null {
  const s = input.trim();
  const parts: string[] = [];
  let i = 0;
  if (s === '') return null;
  for (;;) {
    let part = '';
    if (s[i] === '"') {
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === '"') {
          if (s[i + 1] !== '"') break;
          i++;
        }
        part += s[i];
        i++;
      }
      i++;
    } else {
      const start = i;
      while (i < s.length && s[i] !== '.' && s[i] !== '"') i++;
      part = s.slice(start, i).replace(/[A-Z]/g, (c) => c.toLowerCase());
    }
    if (part === '') return null;
    parts.push(part);
    if (i === s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }
  return parts.length <= 2 ? parts : null;
}

// ---------------------------------------------------------------------------
// Page file names
//
// Each part is encoded separately: lower-case ASCII letters, digits, `_` and
// `-` are kept; every other UTF-8 byte (including `.`, `/`, `%`, upper-case
// letters and non-ASCII) becomes `%XX`. The parts are joined with `.`, which an
// encoded part never contains. The encoding is injective even after case
// folding, so identifiers that differ only by case cannot collide on a
// case-insensitive filesystem, and file names are plain ASCII.

const FILE_SAFE = /^[a-z0-9_-]$/;
/** Longer encoded names switch to a hashed form to stay below common 255-byte limits. */
const MAX_FILE_NAME = 200;

function encodePart(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += FILE_SAFE.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function pageFileName(schema: string, name: string): string {
  const base = `${encodePart(schema)}.${encodePart(name)}`;
  if (base.length + 3 <= MAX_FILE_NAME) return `${base}.md`;
  const digest = createHash('sha256').update(`${schema}\u0000${name}`).digest('hex');
  let prefix = base.slice(0, 120);
  const pct = prefix.lastIndexOf('%');
  if (pct !== -1 && pct > prefix.length - 3) prefix = prefix.slice(0, pct);
  return `${prefix}~${digest}.md`;
}

/** Inverse of pageFileName for the non-hashed form; null for any other file name. */
export function decodePageFileName(file: string): { schema: string; name: string } | null {
  if (!file.endsWith('.md')) return null;
  const base = file.slice(0, -3);
  const dot = base.indexOf('.');
  if (dot <= 0 || dot !== base.lastIndexOf('.') || dot === base.length - 1) return null;
  let schema: string;
  let name: string;
  try {
    schema = decodeURIComponent(base.slice(0, dot));
    name = decodeURIComponent(base.slice(dot + 1));
  } catch {
    return null;
  }
  return pageFileName(schema, name) === file ? { schema, name } : null;
}
