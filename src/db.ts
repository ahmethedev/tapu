import pg from 'pg';

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

/** `postgres://user:secret@host/db` -> `postgres://user:***@host/db`. Unparseable input is fully masked. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const key of [...u.searchParams.keys()]) {
      if (/pass|secret|key|token/i.test(key)) u.searchParams.set(key, '***');
    }
    return u.toString().replace('%2A%2A%2A', '***');
  } catch {
    return '<database url>';
  }
}

/** Secret substrings of a connection URL, in raw and decoded form. */
function secretsOf(url: string): string[] {
  const secrets = new Set<string>([url]);
  try {
    const u = new URL(url);
    if (u.password) {
      secrets.add(u.password);
      try {
        secrets.add(decodeURIComponent(u.password));
      } catch {
        // keep the raw form only
      }
    }
    for (const [key, value] of u.searchParams) {
      if (value && /pass|secret|key|token/i.test(key)) secrets.add(value);
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
 * Opens a read-only session. All queries run inside one `BEGIN READ ONLY`
 * transaction that is rolled back on close. `search_path` is set to
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
    await client.query('BEGIN READ ONLY');
  } catch (err) {
    await client.end().catch(() => {});
    throw new Error(`Could not connect to ${redactUrl(url)}: ${scrubSecrets(errorMessage(err), url)}`);
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

export async function withSession<T>(url: string, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = await openSession(url);
  try {
    return await fn(session);
  } catch (err) {
    throw new Error(scrubSecrets(errorMessage(err), url));
  } finally {
    await session.close().catch(() => {});
  }
}

export function errorMessage(err: unknown): string {
  // Node reports a refused connection to several addresses (IPv4 + IPv6) as an AggregateError with no message.
  if (err instanceof AggregateError && err.errors.length > 0) {
    return [...new Set(err.errors.map(errorMessage))].join('; ');
  }
  if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || err.name;
  return String(err);
}
