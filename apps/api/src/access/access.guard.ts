import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Capability, type OrgRole } from '@eyesonbug/shared';
import { ApiError } from '../common/errors';
import type { AccessContext, AppRequest } from '../common/request-context';
import { AccessService } from './access.service';

export const REQUIRED_CAPABILITY = 'eyesonbug:capability';
export const REQUIRED_ORG_ROLE = 'eyesonbug:orgRole';

/** Declare the project capability a route needs. Enforced server-side. */
export const RequireCapability = (capability: Capability): MethodDecorator =>
  SetMetadata(REQUIRED_CAPABILITY, capability);

/** Declare the organization role a route needs, for org-level administration. */
export const RequireOrgRole = (role: OrgRole): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ORG_ROLE, role);

const ORG_ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Resolves `:org` and `:project` from the path into an `AccessContext`, then
 * enforces whatever the route declared.
 *
 * Authorization is checked here, on the server, every time. The UI shares the
 * same capability table (`@eyesonbug/shared`) purely to decide what to render;
 * it is never the thing that decides what is allowed.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly access: AccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) throw ApiError.unauthorized();

    const params = request.params as { org?: string; project?: string };
    if (!params.org) return true;

    const resolved = params.project
      ? await this.access.forProject(request.user.id, params.org, params.project)
      : await this.access.forOrganization(request.user.id, params.org);

    request.access = resolved;

    const capability = this.reflector.getAllAndOverride<Capability | undefined>(
      REQUIRED_CAPABILITY,
      [context.getHandler(), context.getClass()],
    );
    if (
      capability &&
      !can({ orgRole: resolved.orgRole, projectRole: resolved.projectRole }, capability)
    ) {
      throw ApiError.forbidden(`This action requires the ${capability} permission`);
    }

    const orgRole = this.reflector.getAllAndOverride<OrgRole | undefined>(REQUIRED_ORG_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (orgRole) {
      const actual = resolved.orgRole;
      if (!actual || ORG_ROLE_RANK[actual] < ORG_ROLE_RANK[orgRole]) {
        throw ApiError.forbidden(`This action requires the ${orgRole} organization role`);
      }
    }

    return true;
  }
}

export const Access = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessContext => {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.access) throw ApiError.forbidden();
    return request.access;
  },
);
