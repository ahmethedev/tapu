import pg from 'pg';
import { TapuError, errorMessage } from './errors.js';

export const STATEMENT_TIMEOUT = '15s';
export const IDLE_IN_TRANSACTION_TIMEOUT = '30s';

/** Environment variables checked (in order) after `--db`. */
export const URL_ENV_VARS = ['TAPU_DATABASE_URL', 'DATABASE_URL'] as const;

export function resolveDatabaseUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (flag) return flag;
  for (const name of URL_ENV_VARS) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** Query parameters that can carry credentials; they are left out of redacted URLs. */
const SENSITIVE_PARAM = /pass|secret|key|token|cert/i;

/**
 * `postgres://user:secret@host/db?sslpassword=x` -> `postgres://user:***@host/db`.
 * Sensitive query parameters are omitted. Unparseable input is fully masked.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const key of [...new Set(u.searchParams.keys())]) {
      if (SENSITIVE_PARAM.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace('%2A%2A%2A', '***');
  } catch {
    return '<database url>';
  }
}

/** Secret substrings of a connection URL, in raw, decoded and re-encoded form. */
function secretsOf(url: string): string[] {
  const secrets = new Set<string>([url]);
  const addForms = (value: string) => {
    secrets.add(value);
    try {
      const decoded = decodeURIComponent(value);
      secrets.add(decoded);
      secrets.add(encodeURIComponent(decoded));
    } catch {
      secrets.add(encodeURIComponent(value));
    }
  };
  try {
    const u = new URL(url);
    if (u.password) addForms(u.password);
    for (const [key, value] of u.searchParams) {
      // searchParams values are already decoded.
      if (value && SENSITIVE_PARAM.test(key)) {
        secrets.add(value);
        secrets.add(encodeURIComponent(value));
      }
    }
  } catch {
    // Not a URL: the whole string is treated as secret.
  }
  return [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

/** Removes the URL and its password from a message before it is printed. */
export function scrubSecrets(message: string, url: string | undefined): string {
  if (!url) return message;
  let out = message;
  for (const secret of secretsOf(url)) {
    out = out.split(secret).join(secret === url ? redactUrl(url) : '***');
  }
  return out;
}

export interface Session {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Opens a read-only session. All queries run inside one read-only,
 * repeatable-read transaction (one consistent snapshot for the whole
 * introspection) that is rolled back on close. `search_path` is set to
 * `pg_catalog` so that catalog functions print schema-qualified names.
 */
export async function openSession(url: string): Promise<Session> {
  const client = new pg.Client({ connectionString: url, application_name: 'tapu' });
  // Without a listener, a dropped connection would crash the process with the raw error.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    await client.query('SET default_transaction_read_only = on');
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query(`SET idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`);
    await client.query('SET search_path = pg_catalog');
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  } catch (err) {
    await client.end().catch(() => {});
    throw new TapuError(
      'connection_failed',
      `Could not connect to ${redactUrl(url)}: ${scrubSecrets(errorMessage(err), url)}`,
    );
  }
  return {
    async query(sql, params) {
      const result = await client.query(sql, params);
      return result.rows;
    },
    async close() {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    },
  };
}

/** Runs `fn` in a read-only session; the session is rolled back and released on success or error. */
export async function withSession<T>(url: string, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession(url);
  try {
    return await fn(session);
  } catch (err) {
    if (err instanceof TapuError) throw err;
    throw new TapuError('introspection_failed', `Introspection failed: ${scrubSecrets(errorMessage(err), url)}`);
  } finally {
    await session.close().catch(() => {});
  }
}
