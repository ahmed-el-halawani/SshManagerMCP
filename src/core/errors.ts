export type ErrorCode =
  | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT'
  | 'SSH_NOT_INSTALLED' | 'ENVIRONMENT_MISMATCH' | 'DNS_FAILED' | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT' | 'NETWORK_UNREACHABLE' | 'AUTH_REQUIRED' | 'TRUST_REQUIRED'
  | 'HOST_KEY_CHANGED' | 'PROBE_UNSUPPORTED' | 'REMOTE_COMMAND_FAILED' | 'OUTPUT_LIMIT'
  | 'CHECK_IN_PROGRESS' | 'LEASE_HELD' | 'PATH_OVERLAP' | 'DATABASE_BUSY' | 'SCHEMA_TOO_NEW' | 'INTERNAL_ERROR';

export class AppError extends Error {
  code: ErrorCode;
  retryable: boolean;
  details: Record<string, unknown>;
  next_action?: string;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; next_action?: string } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
    this.next_action = opts.next_action;
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, next_action: this.next_action, ...this.details };
  }
}

export const notFound = (what: string, id: string) => new AppError('NOT_FOUND', `${what} ${id} not found`, { details: { id } });
