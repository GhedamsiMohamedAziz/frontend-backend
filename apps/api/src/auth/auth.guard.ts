import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import { env } from '../config/env';
import { SessionService } from './session.service';

export const IS_PUBLIC = 'eyesonbug:public';

/** Opt a route out of authentication. Everything else requires a session. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Authentication is applied globally and removed per route, rather than added
 * per route. A new endpoint is therefore private by default: forgetting the
 * decorator fails closed instead of publishing data.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[env().SESSION_COOKIE_NAME];

    const user = await this.sessions.resolve(token);
    if (!user) throw ApiError.unauthorized();

    request.user = user;
    return true;
  }
}
