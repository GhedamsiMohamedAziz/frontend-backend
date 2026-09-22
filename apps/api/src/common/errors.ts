import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every failure leaves the API in one shape, so the client has exactly one
 * error-rendering path. `code` is stable and machine-readable; `message` is for
 * a human and may change.
 */
export class ApiError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super({ error: { code, message, details } }, status);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError('bad_request', message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError('unauthorized', message, HttpStatus.UNAUTHORIZED);
  }

  /**
   * Returned when the caller is authenticated but lacks the capability.
   * Note that a resource in another tenant produces `notFound`, not this:
   * telling a stranger that a project exists is itself a disclosure.
   */
  static forbidden(message = 'You do not have permission to do that'): ApiError {
    return new ApiError('forbidden', message, HttpStatus.FORBIDDEN);
  }

  static notFound(what = 'Resource'): ApiError {
    return new ApiError('not_found', `${what} not found`, HttpStatus.NOT_FOUND);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError('conflict', message, HttpStatus.CONFLICT, details);
  }
}
