import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  issueTrackerEnum,
  primaryId,
  triageCategoryEnum,
  triageResolutionEnum,
  triageSourceEnum,
  ts,
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
 * The clustering key: sha256(version ‖ project ‖ error type ‖ normalized
 * message ‖ leading application stack frames).
 *
 * This is what turns "12 tests failed with the same timeout on /checkout" into
 * one row a human decides about once, rather than twelve identical decisions.
 */
export const errorSignatures = pgTable(
  'error_signature',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    hash: text().notNull(),
    errorType: text().notNull(),
    normalizedMessage: text().notNull(),
    normalizedStackHead: text().notNull().default(''),
    firstSeenAt: createdAt(),
    lastSeenAt: createdAt(),
    occurrenceCount: integer().notNull().default(0),
    knownIssueId: uuid(),
  },
  (t) => [
    uniqueIndex('error_signature_project_hash_key').on(t.projectId, t.hash),
    index('error_signature_project_last_seen_idx').on(t.projectId, t.lastSeenAt.desc()),
  ],
);

export const knownIssues = pgTable(
  'known_issue',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    title: text().notNull(),
    tracker: issueTrackerEnum().notNull().default('github'),
    externalKey: text(),
    externalUrl: text(),
    status: text().notNull().default('open'),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    closedAt: ts(),
  },
  (t) => [index('known_issue_project_status_idx').on(t.projectId, t.status)],
);

/** A known issue can absorb several signatures as a bug is understood. */
export const knownIssueSignatures = pgTable(
  'known_issue_signature',
  {
    knownIssueId: uuid()
      .notNull()
      .references(() => knownIssues.id, { onDelete: 'cascade' }),
    errorSignatureId: uuid()
      .notNull()
      .references(() => errorSignatures.id, { onDelete: 'cascade' }),
    organizationId: orgId(),
  },
  (t) => [primaryKey({ columns: [t.knownIssueId, t.errorSignatureId] })],
);

/**
 * A triage decision, about either one result or a whole signature cluster.
 *
 * `source` and `confidence` exist from day one so that when M6 lands, an AI
 * suggestion is the same kind of row as a human decision and can be compared
 * against one directly. AI suggests; a human decides.
 */
export const triages = pgTable(
  'triage',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    errorSignatureId: uuid().references(() => errorSignatures.id, { onDelete: 'cascade' }),
    /** No FK: `test_result` is partitioned with a composite key (ADR-012). */
    testResultId: uuid(),
    category: triageCategoryEnum().notNull(),
    assigneeUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    comment: text(),
    knownIssueId: uuid().references(() => knownIssues.id, { onDelete: 'set null' }),
    source: triageSourceEnum().notNull().default('human'),
    /** Null for human decisions; 0..1 for AI suggestions. */
    confidence: numeric({ precision: 4, scale: 3 }),
    triagedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    triagedAt: createdAt(),
    /** Set when a later decision replaces this one; nothing is overwritten. */
    supersededById: uuid(),
    resolution: triageResolutionEnum(),
    resolvedAt: ts(),
  },
  (t) => [
    index('triage_project_triaged_idx').on(t.projectId, t.triagedAt.desc()),
    index('triage_signature_idx').on(t.errorSignatureId),
    index('triage_result_idx').on(t.testResultId),
  ],
);

/**
 * The frozen input to a triage decision (ADR-009).
 *
 * This is the M6 requirement made concrete: a decision is only a usable
 * training label if the model can later be shown exactly what the human saw.
 * Re-deriving it at training time would be subtly wrong — the test gets
 * renamed, the screenshot expires under retention, the stack normalizer
 * improves — so the snapshot is written in the same transaction as the
 * decision and never updated afterwards.
 *
 * `schemaVersion` lets the payload shape evolve without invalidating old rows.
 */
export const triageContexts = pgTable(
  'triage_context',
  {
    triageId: uuid()
      .primaryKey()
      .references(() => triages.id, { onDelete: 'cascade' }),
    organizationId: orgId(),
    projectId: projectId(),
    schemaVersion: integer().notNull().default(1),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('triage_context_project_idx').on(t.projectId)],
);

export const comments = pgTable(
  'comment',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    mentions: uuid().array().notNull().default([]),
    createdAt: createdAt(),
    editedAt: ts(),
    deletedAt: ts(),
  },
  (t) => [index('comment_subject_idx').on(t.subjectType, t.subjectId, t.createdAt)],
);
