import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ProjectSettings } from '@eyesonbug/shared';
import {
  createdAt,
  orgRoleEnum,
  primaryId,
  projectRoleEnum,
  themeEnum,
  ts,
  uiLocaleEnum,
  updatedAt,
} from './_shared';

export const organizations = pgTable(
  'organization',
  {
    id: primaryId(),
    slug: text().notNull(),
    name: text().notNull(),
    plan: text().notNull().default('free'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('organization_slug_key').on(t.slug)],
);

/**
 * Users are global, not per-organization: one GitHub identity can belong to
 * several customer organizations, which is the normal case for contractors and
 * for anyone evaluating the product alongside their day job.
 */
export const users = pgTable(
  'user',
  {
    id: primaryId(),
    githubUserId: integer(),
    githubLogin: text(),
    email: text(),
    name: text().notNull(),
    avatarUrl: text(),
    locale: uiLocaleEnum().notNull().default('en'),
    theme: themeEnum().notNull().default('system'),
    createdAt: createdAt(),
    lastSeenAt: ts(),
  },
  (t) => [
    uniqueIndex('user_github_user_id_key').on(t.githubUserId),
    uniqueIndex('user_email_key').on(t.email),
  ],
);

export const sessions = pgTable(
  'session',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Only a hash is stored; the cookie holds the single copy of the secret. */
    tokenHash: text().notNull(),
    userAgent: text(),
    ip: text(),
    createdAt: createdAt(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex('session_token_hash_key').on(t.tokenHash),
    index('session_user_idx').on(t.userId),
    index('session_expires_idx').on(t.expiresAt),
  ],
);

export const orgMemberships = pgTable(
  'org_membership',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum().notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('org_membership_user_idx').on(t.userId),
  ],
);

export const projects = pgTable(
  'project',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    repoFullName: text(),
    defaultBranch: text().notNull().default('main'),
    settings: jsonb().$type<ProjectSettings>().notNull().default({
      flakinessWindow: '14d',
      flakinessSampleSize: 50,
      quarantineBlocksGate: false,
    }),
    /** Per-project run counter, so runs are `#412` rather than a uuid. */
    runCounter: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts(),
  },
  (t) => [
    uniqueIndex('project_org_slug_key').on(t.organizationId, t.slug),
    index('project_org_idx').on(t.organizationId),
  ],
);

export const projectMemberships = pgTable(
  'project_membership',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: projectRoleEnum().notNull().default('viewer'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_membership_user_idx').on(t.userId),
  ],
);

export const teams = pgTable(
  'team',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('team_org_slug_key').on(t.organizationId, t.slug)],
);

export const teamMemberships = pgTable(
  'team_membership',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const environments = pgTable(
  'environment',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    baseUrl: text(),
    isProduction: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('environment_project_name_key').on(t.projectId, t.name)],
);

export const apiTokens = pgTable(
  'api_token',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null means org-wide; in practice tokens are scoped to one project. */
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    tokenHash: text().notNull(),
    /** First 8 characters, shown in the UI so a token is recognisable. */
    tokenPrefix: text().notNull(),
    scopes: text().array().notNull().default(['ingest:write']),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: ts(),
    expiresAt: ts(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex('api_token_hash_key').on(t.tokenHash),
    index('api_token_project_idx').on(t.projectId),
  ],
);

export const auditLogs = pgTable(
  'audit_log',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorTokenId: uuid().references(() => apiTokens.id, { onDelete: 'set null' }),
    action: text().notNull(),
    subjectType: text().notNull(),
    subjectId: text(),
    before: jsonb(),
    after: jsonb(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_org_created_idx').on(t.organizationId, t.createdAt.desc())],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(orgMemberships),
  projects: many(projects),
  teams: many(teams),
}));

export const usersRelations = relations(users, ({ many }) => ({
  orgMemberships: many(orgMemberships),
  projectMemberships: many(projectMemberships),
  sessions: many(sessions),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  memberships: many(projectMemberships),
  environments: many(environments),
}));

export const orgMembershipsRelations = relations(orgMemberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgMemberships.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [orgMemberships.userId], references: [users.id] }),
}));

export const projectMembershipsRelations = relations(projectMemberships, ({ one }) => ({
  project: one(projects, { fields: [projectMemberships.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMemberships.userId], references: [users.id] }),
}));
