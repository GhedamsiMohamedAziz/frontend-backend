import { PROJECT_ROLE_RANK, type OrgRole, type ProjectRole } from './enums.js';

/**
 * One capability table, shared by the API guard and the UI.
 *
 * The server is the enforcement point; the client imports this only to decide
 * what to render. Keeping both on the same table is what stops the UI from
 * offering a button the API will refuse — a much more common bug than a
 * genuine authorization hole, and a far more visible one.
 */
export const CAPABILITIES = [
  'project:read',
  'run:trigger',
  'run:cancel',
  'test:quarantine',
  'triage:write',
  'issue:create',
  'project:write',
  'environment:manage',
  'workflow:manage',
  'schedule:manage',
  'gate:manage',
  'notification:manage',
  'member:manage',
  'token:manage',
  'retention:manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The least project role that grants each capability. */
const REQUIRED_ROLE: Readonly<Record<Capability, ProjectRole>> = {
  'project:read': 'viewer',

  'run:trigger': 'qa',
  'run:cancel': 'qa',
  'test:quarantine': 'qa',
  'triage:write': 'qa',
  'issue:create': 'qa',

  'project:write': 'maintainer',
  'environment:manage': 'maintainer',
  'workflow:manage': 'maintainer',
  'schedule:manage': 'maintainer',
  'gate:manage': 'maintainer',
  'notification:manage': 'maintainer',

  'member:manage': 'admin',
  'token:manage': 'admin',
  'retention:manage': 'admin',
};

export interface AccessContext {
  /** Role in the organization that owns the project, if any. */
  orgRole: OrgRole | null;
  /** Role granted on this specific project, if any. */
  projectRole: ProjectRole | null;
}

/**
 * An org `owner` or `admin` is implicitly project `admin` everywhere in that
 * org, so adding a project does not require re-granting access to the people
 * who administer the org.
 */
export function effectiveProjectRole(ctx: AccessContext): ProjectRole | null {
  if (ctx.orgRole === 'owner' || ctx.orgRole === 'admin') return 'admin';
  return ctx.projectRole;
}

export function can(ctx: AccessContext, capability: Capability): boolean {
  const role = effectiveProjectRole(ctx);
  if (role === null) return false;
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[REQUIRED_ROLE[capability]];
}

export function requiredRoleFor(capability: Capability): ProjectRole {
  return REQUIRED_ROLE[capability];
}

/** Everything a given context may do — used to send the UI one flat list. */
export function capabilitiesFor(ctx: AccessContext): Capability[] {
  return CAPABILITIES.filter((capability) => can(ctx, capability));
}
