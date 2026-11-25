/** Typed operation errors. `status` is the HTTP status adapters use. */
export const ERROR_STATUS = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  signature_required: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  // The session is valid but holds no sealed GitHub user token: reconnect GitHub, do not sign out.
  github_user_token_missing: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class OpError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  /** Extra facts for the audit row of a refused write (never sent to the caller). */
  readonly auditDetail: Record<string, unknown> | undefined;
  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown,
    auditDetail?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.auditDetail = auditDetail;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export type ErrorBody = { error: { code: ErrorCode; message: string; details?: unknown } };

export function errorBody(err: OpError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    },
  };
}
