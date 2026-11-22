/** Base class for provider failures. `retryable` tells the scheduler whether a retry can help. */
export abstract class ProviderError extends Error {
  abstract readonly retryable: boolean;
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Infrastructure trouble (network, quota, daemon down, sandbox lost). Retrying may succeed. */
export class InfraError extends ProviderError {
  readonly retryable = true;
}

/**
 * Infrastructure trouble that usually clears on its own: a timeout, a dropped connection, a 429,
 * a 502, 503 or 504. Safe to retry for a call that is idempotent; see retryTransient.
 */
export class TransientError extends InfraError {}

/** The request is invalid or can never succeed as stated. Do not retry. */
export class SpecError extends ProviderError {
  readonly retryable = false;
}

/** The sandbox does not exist (never created, expired or already destroyed). */
export class SandboxNotFoundError extends SpecError {}

/** A file transfer exceeded its byte cap. */
export class FileTooLargeError extends SpecError {}
