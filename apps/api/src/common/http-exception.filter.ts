import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '@eyesonbug/shared';
import { logger } from './logger';

/**
 * One exit point for every error.
 *
 * Unexpected errors are logged with their stack and returned as an opaque
 * `internal_error`: a stack trace in an HTTP response tells an attacker about
 * file layout and dependency versions, and tells the user nothing useful.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = request.id as string | undefined;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body: ApiErrorBody =
        typeof response === 'object' && response !== null && 'error' in response
          ? { error: { ...(response as ApiErrorBody).error, requestId } }
          : {
              error: {
                code: httpCodeToSlug(status),
                message: typeof response === 'string' ? response : exception.message,
                requestId,
              },
            };

      if (status >= 500) logger.error({ err: exception, requestId }, 'request failed');
      void reply.status(status).send(body);
      return;
    }

    logger.error({ err: exception, requestId }, 'unhandled exception');
    const body: ApiErrorBody = {
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side.',
        requestId,
      },
    };
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(body);
  }
}

function httpCodeToSlug(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'bad_request';
    case HttpStatus.UNAUTHORIZED:
      return 'unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    default:
      return 'error';
  }
}
