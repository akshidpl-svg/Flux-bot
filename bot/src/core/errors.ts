/**
 * Error types. `AppError` messages are safe to show to Discord users: they must
 * never contain credentials, stack traces or provider payloads.
 */
export class AppError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(code: string, userMessage: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(userMessage, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = options?.retryable ?? false;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation', message);
    this.name = 'ValidationError';
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = 'Insufficient available balance for this transaction (including the application fee).') {
    super('insufficient_funds', message);
    this.name = 'InsufficientFundsError';
  }
}

export class PausedError extends AppError {
  constructor() {
    super('paused', 'FluxTip is in emergency read-only mode. New transfers and withdrawals are paused; history is still available.');
    this.name = 'PausedError';
  }
}

export class ProviderError extends AppError {
  constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super('provider', message, options);
    this.name = 'ProviderError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('not_found', message);
    this.name = 'NotFoundError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
