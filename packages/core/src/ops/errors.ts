/** Typed operation errors. `status` is the HTTP status adapters use. */
export const ERROR_STATUS = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  signature_required: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class OpError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
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
