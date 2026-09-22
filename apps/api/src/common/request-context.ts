import type { FastifyRequest } from 'fastify';
import type { Capability, OrgRole, ProjectRole } from '@eyesonbug/shared';
import type { SessionUser } from '../auth/session.service';

/**
 * What a guard has established about the caller, resolved once per request and
 * read by everything downstream.
 */
export interface AccessContext {
  organizationId: string;
  organizationSlug: string;
  orgRole: OrgRole | null;
  projectId: string | null;
  projectSlug: string | null;
  projectRole: ProjectRole | null;
  capabilities: Capability[];
}

export interface RequestState {
  user?: SessionUser;
  /** Set when the caller is a CI token rather than a person. */
  tokenId?: string;
  access?: AccessContext;
}

export type AppRequest = FastifyRequest & RequestState;
