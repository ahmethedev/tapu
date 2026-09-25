/**
 * Column-name patterns that mark a column as sensitive.
 *
 * Matching rule: the column name is lower-cased and split on `_`; a pattern
 * (also split on `_`) matches when its parts appear as consecutive parts of the
 * name. So `user_email` matches `email`, `tokens_used_count` does not match
 * `token`, and `emailed_at` does not match `email`.
 */
export const SENSITIVE_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'ssn',
  'email',
  'phone',
  'mobile',
  'iban',
  'card_number',
  'cvv',
  'dob',
  'birth_date',
  'address',
  'ip_address',
  'tc_kimlik',
  'tckn',
  'kimlik_no',
  'vergi_no',
  'salary',
  'maas',
] as const;

const SPLIT_PATTERNS = SENSITIVE_PATTERNS.map((p) => p.split('_'));

/** Returns the first pattern the column name matches, or null. */
export function matchSensitive(columnName: string): string | null {
  const parts = columnName.toLowerCase().split('_');
  for (let p = 0; p < SPLIT_PATTERNS.length; p++) {
    const pattern = SPLIT_PATTERNS[p]!;
    for (let i = 0; i + pattern.length <= parts.length; i++) {
      if (pattern.every((part, j) => parts[i + j] === part)) return SENSITIVE_PATTERNS[p]!;
    }
  }
  return null;
}

export function isSensitiveName(columnName: string): boolean {
  return matchSensitive(columnName) !== null;
}
