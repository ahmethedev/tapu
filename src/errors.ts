/** Stable error codes shared by the CLI (JSON output) and the MCP tools. */
export type ErrorCode =
  | 'not_initialized'
  | 'invalid_config'
  | 'invalid_catalog'
  | 'invalid_project_dir'
  | 'unsafe_path'
  | 'io_error'
  | 'invalid_arguments'
  | 'invalid_name'
  | 'unknown_relation'
  | 'ambiguous_name'
  | 'too_many_relations'
  | 'cursor_invalid'
  | 'no_database_url'
  | 'connection_failed'
  | 'introspection_failed'
  | 'internal_error';

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class TapuError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TapuError';
  }

  toJSON(): ErrorObject {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
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

/**
 * Converts anything thrown into an error object. Unknown exceptions keep only
 * their message (never the raw object or stack); `scrub` removes credentials.
 */
export function toErrorObject(err: unknown, scrub: (text: string) => string = (t) => t): ErrorObject {
  if (err instanceof TapuError) {
    const obj = err.toJSON();
    return { ...obj, message: scrub(obj.message) };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return { code: 'io_error', message: scrub(errorMessage(err)) };
  }
  return { code: 'internal_error', message: scrub(errorMessage(err)) };
}
