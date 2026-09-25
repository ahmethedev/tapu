import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openSession, redactUrl, resolveDatabaseUrl, scrubSecrets, type Session } from '../src/db.js';
import { ADMIN_URL, resetFixture } from './helpers.js';

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
             current_setting('idle_in_transaction_session_timeout') AS idle`);
    expect(row).toEqual({ tx: 'on', def: 'on', st: '15s', idle: '30s' });
  });
});

describe('secrets', () => {
  it('redacts the password in URLs', () => {
    expect(redactUrl('postgres://user:hunter2@db.example.com:5432/app')).toBe(
      'postgres://user:***@db.example.com:5432/app',
    );
    expect(redactUrl('postgres://db.example.com/app?password=hunter2')).toBe(
      'postgres://db.example.com/app?password=***',
    );
    expect(redactUrl('not a url with hunter2')).toBe('<database url>');
  });

  it('scrubs the password (raw and decoded) and the full URL from messages', () => {
    const url = 'postgres://user:p%40ss-w0rd@host/db';
    const msg = `failed for ${url}; password p%40ss-w0rd / p@ss-w0rd`;
    const out = scrubSecrets(msg, url);
    expect(out).not.toContain('p%40ss-w0rd');
    expect(out).not.toContain('p@ss-w0rd');
    expect(out).toContain('postgres://user:***@host/db');
  });

  it('resolves the URL from --db, then TAPU_DATABASE_URL, then DATABASE_URL', () => {
    expect(resolveDatabaseUrl('a', { TAPU_DATABASE_URL: 'b', DATABASE_URL: 'c' })).toBe('a');
    expect(resolveDatabaseUrl(undefined, { TAPU_DATABASE_URL: 'b', DATABASE_URL: 'c' })).toBe('b');
    expect(resolveDatabaseUrl(undefined, { DATABASE_URL: 'c' })).toBe('c');
    expect(resolveDatabaseUrl(undefined, {})).toBeUndefined();
  });
});
