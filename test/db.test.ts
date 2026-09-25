import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSession, redactUrl, resolveDatabaseUrl, scrubSecrets, withSession, type Session } from '../src/db.js';
import { ADMIN_URL, adminSql, resetFixture } from './helpers.js';

describe('read-only session', () => {
  let session: Session | undefined;

  beforeAll(resetFixture);
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it('rejects INSERT with a read-only error', async () => {
    session = await openSession(ADMIN_URL);
    await expect(session.query(`INSERT INTO public.audit_events (action) VALUES ('x')`)).rejects.toThrow(
      /read-only transaction/,
    );
  });

  it('rejects CREATE TABLE with a read-only error', async () => {
    session = await openSession(ADMIN_URL);
    await expect(session.query('CREATE TABLE public.tapu_should_not_exist (id int)')).rejects.toThrow(
      /read-only transaction/,
    );
  });

  it('sets read-only defaults and timeouts', async () => {
    session = await openSession(ADMIN_URL);
    const [row] = await session.query<Record<string, string>>(`
      SELECT current_setting('transaction_read_only') AS tx,
             current_setting('default_transaction_read_only') AS def,
             current_setting('statement_timeout') AS st,
             current_setting('idle_in_transaction_session_timeout') AS idle,
             current_setting('transaction_isolation') AS iso`);
    expect(row).toEqual({ tx: 'on', def: 'on', st: '15s', idle: '30s', iso: 'repeatable read' });
  });

  it('reads one consistent snapshot for the whole session', async () => {
    session = await openSession(ADMIN_URL);
    const count = async () =>
      (await session!.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_class WHERE relname = 'tapu_snapshot_probe'`))[0]!.n;
    expect(await count()).toBe('0');
    await adminSql('CREATE TABLE public.tapu_snapshot_probe (id int)');
    try {
      expect(await count()).toBe('0');
    } finally {
      await adminSql('DROP TABLE public.tapu_snapshot_probe');
    }
  });

  it('rolls back and releases the connection on error', async () => {
    await expect(
      withSession(ADMIN_URL, async (s) => {
        await s.query('SELECT 1/0');
      }),
    ).rejects.toMatchObject({ code: 'introspection_failed' });
    const client = new pg.Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      // The server process exits shortly after the client disconnects.
      let open = -1;
      for (let i = 0; i < 40 && open !== 0; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 50));
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'tapu'`);
        open = rows[0].n;
      }
      expect(open).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('secrets', () => {
  it('redacts the password in URLs', () => {
    expect(redactUrl('postgres://user:hunter2@db.example.com:5432/app')).toBe(
      'postgres://user:***@db.example.com:5432/app',
    );
    expect(redactUrl('postgres://db.example.com/app?password=hunter2&sslmode=require&sslpassword=x')).toBe(
      'postgres://db.example.com/app?sslmode=require',
    );
    expect(redactUrl('not a url with hunter2')).toBe('<database url>');
  });

  it('scrubs the password (raw, decoded and URL-encoded) and the full URL from messages', () => {
    const url = 'postgres://user:p%40ss-w0rd!@host/db';
    const msg = `failed for ${url}; password p%40ss-w0rd! / p@ss-w0rd! / ${encodeURIComponent('p@ss-w0rd!')}`;
    const out = scrubSecrets(msg, url);
    expect(out).not.toContain('ss-w0rd');
    expect(out).toContain('postgres://user:***@host/db');
    expect(scrubSecrets('x sslpassword=abc123 y', 'postgres://h/db?sslpassword=abc123')).toBe('x sslpassword=*** y');
  });

  it('explains refused connections instead of printing "AggregateError"', async () => {
    const url = 'postgres://user:hunter2@localhost:1/db';
    const err = await openSession(url).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe('connection_failed');
    expect(err?.message).toMatch(/^Could not connect to postgres:\/\/user:\*\*\*@localhost:1\/db: .*ECONNREFUSED/);
    expect(err?.message).not.toContain('hunter2');
  });

  it('resolves the URL from --db, then TAPU_DATABASE_URL, then DATABASE_URL', () => {
    expect(resolveDatabaseUrl('a', { TAPU_DATABASE_URL: 'b', DATABASE_URL: 'c' })).toBe('a');
    expect(resolveDatabaseUrl(undefined, { TAPU_DATABASE_URL: 'b', DATABASE_URL: 'c' })).toBe('b');
    expect(resolveDatabaseUrl(undefined, { DATABASE_URL: 'c' })).toBe('c');
    expect(resolveDatabaseUrl(undefined, {})).toBeUndefined();
  });
});
