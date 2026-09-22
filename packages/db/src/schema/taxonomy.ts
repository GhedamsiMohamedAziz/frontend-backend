import { index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, featureSourceEnum, primaryId, ts } from './_shared';
import { organizations, projects, teams, users } from './tenancy';

/** Org id on every tenant table: it is the RLS predicate (ADR-002). */
const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

const projectId = () =>
  uuid()
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

export const suites = pgTable(
  'suite',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    name: text().notNull(),
    path: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suite_project_name_key').on(t.projectId, t.name)],
);

export const features = pgTable(
  'feature',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    key: text().notNull(),
    name: text().notNull(),
    description: text(),
    source: featureSourceEnum().notNull().default('path'),
    ownerTeamId: uuid().references(() => teams.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('feature_project_key_key').on(t.projectId, t.key)],
);

/**
 * The stable identity of a test across runs (ADR-007).
 *
 * `fingerprint` is sha256(version ‖ project ‖ normalized path ‖ full title ‖
 * canonical params). Everything that trends over time — history, flakiness,
 * duration regressions, quarantine, owned-by-my-team — hangs off this row
 * rather than off any individual run.
 */
export const testCases = pgTable(
  'test_case',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    fingerprint: text().notNull(),
    suiteId: uuid().references(() => suites.id, { onDelete: 'set null' }),
    featureId: uuid().references(() => features.id, { onDelete: 'set null' }),
    filePath: text().notNull(),
    title: text().notNull(),
    fullTitle: text().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ownerTeamId: uuid().references(() => teams.id, { onDelete: 'set null' }),
    /**
     * Quarantined tests still execute — the point is to keep collecting
     * evidence about them — they simply cannot fail the quality gate.
     */
    quarantinedAt: ts(),
    quarantineReason: text(),
    quarantinedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    firstSeenAt: createdAt(),
    lastSeenAt: createdAt(),
    /** Set when a test stops appearing; never hard-deleted, so history survives. */
    retiredAt: ts(),
  },
  (t) => [
    uniqueIndex('test_case_project_fingerprint_key').on(t.projectId, t.fingerprint),
    index('test_case_project_feature_idx').on(t.projectId, t.featureId),
    index('test_case_project_owner_idx').on(t.projectId, t.ownerTeamId),
  ],
);

/**
 * A rename changes the fingerprint, which would otherwise reset a test's entire
 * history. An alias lets a human say "the test that now hashes to X is the test
 * that used to hash to Y", and lookup resolves fingerprint → alias → test_case.
 *
 * Deliberately human-confirmed: a wrong automatic merge silently corrupts
 * history in a way nobody notices until a trend line lies.
 */
export const testCaseAliases = pgTable(
  'test_case_alias',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    testCaseId: uuid()
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    fingerprint: text().notNull(),
    reason: text().notNull().default('manual'),
    mergedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('test_case_alias_project_fingerprint_key').on(t.projectId, t.fingerprint),
    index('test_case_alias_test_case_idx').on(t.testCaseId),
  ],
);

export const tags = pgTable(
  'tag',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    name: text().notNull(),
  },
  (t) => [uniqueIndex('tag_project_name_key').on(t.projectId, t.name)],
);

export const testCaseTags = pgTable(
  'test_case_tag',
  {
    testCaseId: uuid()
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    organizationId: orgId(),
  },
  (t) => [
    primaryKey({ columns: [t.testCaseId, t.tagId] }),
    index('test_case_tag_tag_idx').on(t.tagId),
  ],
);
