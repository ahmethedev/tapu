import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL } from './helpers.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'scripts', 'token-compare.js');

async function report(): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, '--runs', '2'], {
    env: { PATH: process.env.PATH ?? '', TAPU_TEST_DATABASE_URL: ADMIN_URL },
  });
  return stdout;
}

describe('scripts/token-compare', () => {
  it('reports the same sizes on every run and labels unequal comparisons', async () => {
    const first = await report();
    const second = await report();
    const sizes = (text: string) => text.slice(0, text.indexOf('## Latency'));
    expect(sizes(second)).toBe(sizes(first));

    expect(first).toContain('≈tokens = characters / 4 (an estimate, not a tokenizer measurement)');
    expect(first).toContain('## A and B (different information; the ratio is descriptive only)');
    expect(first).toMatch(/C, metadata only[\s\S]*tool definitions[\s\S]*shared envelopes[\s\S]*selected structure[\s\S]*workflow total/);
    expect(first).toContain('C, enriched');
    expect(first).toContain('deterministic warnings (fk_without_index, undocumented, …): C yes, D no');
    expect(first).toContain('Local retrieval latency is not agent task duration');
    expect(first).toMatch(/Hardware: .+; Node v\d+/);
  }, 60_000);
});
