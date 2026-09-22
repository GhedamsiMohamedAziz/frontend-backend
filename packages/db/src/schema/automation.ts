import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  attachmentKindEnum,
  createdAt,
  notificationChannelEnum,
  notificationEventEnum,
  primaryId,
  ts,
  updatedAt,
} from './_shared';
import { organizations, projects, users } from './tenancy';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

const projectId = () =>
  uuid()
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

/**
 * A GitHub App installation, per organization (ADR-011).
 * The App — not an OAuth App — is what allows `checks:write` and acting on the
 * repository without borrowing a particular user's token.
 */
export const githubInstallations = pgTable(
  'github_installation',
  {
    id: primaryId(),
    organizationId: orgId(),
    installationId: bigint({ mode: 'number' }).notNull(),
    accountLogin: text().notNull(),
    accountType: text().notNull().default('Organization'),
    repositories: jsonb().$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    suspendedAt: ts(),
  },
  (t) => [uniqueIndex('github_installation_installation_id_key').on(t.installationId)],
);

/**
 * A reusable run template. `inputsSchema` is read from the workflow file's
 * `workflow_dispatch.inputs`, so the launcher form is generated rather than
 * hand-maintained and cannot drift from the workflow it triggers.
 */
export const workflowConfigs = pgTable(
  'workflow_config',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    name: text().notNull(),
    repoFullName: text().notNull(),
    workflowFile: text().notNull(),
    ref: text().notNull().default('main'),
    inputsSchema: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    defaultInputs: jsonb().$type<Record<string, string>>().notNull().default({}),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('workflow_config_project_name_key').on(t.projectId, t.name)],
);

export const schedules = pgTable(
  'schedule',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    workflowConfigId: uuid()
      .notNull()
      .references(() => workflowConfigs.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    cron: text().notNull(),
    /** IANA zone, so "every weekday at 02:00 Europe/Paris" survives DST. */
    timezone: text().notNull().default('UTC'),
    inputs: jsonb().$type<Record<string, string>>().notNull().default({}),
    enabled: boolean().notNull().default(true),
    nextRunAt: ts(),
    lastRunAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('schedule_next_run_idx').on(t.enabled, t.nextRunAt)],
);

export const qualityGates = pgTable(
  'quality_gate',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    name: text().notNull(),
    /** e.g. { minPassRate: 0.98, allowNewFailures: false, ignoreQuarantined: true } */
    rules: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    appliesToBranches: text().array().notNull().default(['main']),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('quality_gate_project_name_key').on(t.projectId, t.name)],
);

export const notificationRules = pgTable(
  'notification_rule',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    event: notificationEventEnum().notNull(),
    channel: notificationChannelEnum().notNull(),
    /** Webhook URL or address. Encrypted at rest before it reaches this column. */
    target: text().notNull(),
    filter: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('notification_rule_project_event_idx').on(t.projectId, t.event)],
);

export const retentionPolicies = pgTable(
  'retention_policy',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    artifactKind: attachmentKindEnum().notNull(),
    keepDays: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('retention_policy_project_kind_key').on(t.projectId, t.artifactKind)],
);

/** A named, shareable filter state. Same vocabulary as the URL (`RunFilters`). */
export const savedViews = pgTable(
  'saved_view',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    /** Null when shared with the whole project. */
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    scope: text().notNull().default('history'),
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    isShared: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('saved_view_project_scope_idx').on(t.projectId, t.scope)],
);
