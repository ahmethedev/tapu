import { describe, expect, it } from 'vitest';
import { sanitizeUntrusted, UNTRUSTED_MAX_CHARS } from '../src/sanitize.js';

describe('sanitizeUntrusted', () => {
  it('strips control characters but keeps newlines', () => {
    expect(sanitizeUntrusted('DROP TABLE customers;\u0007')).toBe('DROP TABLE customers;');
    expect(sanitizeUntrusted('a\u0000b\tc\r\nd\u001be\u007ff\u009bg')).toBe('abc\ndefg');
  });

  it('caps fields at 500 characters with a marker', () => {
    const out = sanitizeUntrusted('x'.repeat(2000));
    expect(Array.from(out)).toHaveLength(UNTRUSTED_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeUntrusted('y'.repeat(500))).toBe('y'.repeat(500));
  });

  it('does not split surrogate pairs when truncating', () => {
    const out = sanitizeUntrusted('😀'.repeat(600));
    expect(Array.from(out)).toHaveLength(UNTRUSTED_MAX_CHARS);
    expect(out).toBe('😀'.repeat(499) + '…');
  });
});
