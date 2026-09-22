import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiError } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import type { SessionUser } from './session.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) throw ApiError.unauthorized();
    return request.user;
  },
);
