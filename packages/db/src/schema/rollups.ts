import { date, index, integer, numeric, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createdAt, resultStatusEnum, statsWindowEnum, ts, updatedAt } from './_shared';
import { environments, organizations, projects } from './tenancy';
import { configurations } from './execution';
import { features, testCases } from './taxonomy';

/**
 * Pre-aggregated metrics (ADR-010).
 *
 * Nothing in this file is ever computed on read. A project with millions of
 * historical results cannot answer "pass rate by feature over 90 days" from the
 * fact table inside a page load, so the worker maintains these incrementally on
 * run completion, plus a nightly reconciliation to heal drift.
 */

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

const projectId = () =>
  uuid()
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

export const testCaseStats = pgTable(
  'test_case_stats',
  {
    testCaseId: uuid()
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    window: statsWindowEnum().notNull(),
    organizationId: orgId(),
    projectId: projectId(),
    runs: integer().notNull().default(0),
    passed: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    skipped: integer().notNull().default(0),
    /**
     * How many times the test both passed and failed on the same commit and
     * configuration — the definition of flaky, counted rather than guessed.
     */
    flakyTransitions: integer().notNull().default(0),
    flakinessScore: numeric({ precision: 5, scale: 4 }).notNull().default('0'),
    p50DurationMs: integer(),
    p95DurationMs: integer(),
    lastFailureAt: ts(),
    lastPassedAt: ts(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.testCaseId, t.window] }),
    index('test_case_stats_flakiness_idx').on(t.projectId, t.window, t.flakinessScore.desc()),
    index('test_case_stats_duration_idx').on(t.projectId, t.window, t.p95DurationMs.desc()),
  ],
);

/**
 * One table serves "pass rate overall", "by feature", "by configuration" and
 * "by environment". The dimension columns are nullable: a NULL means "all", so
 * a single row shape answers every slice instead of a table per dimension.
 */
export const dailyProjectMetrics = pgTable(
  'daily_project_metrics',
  {
    organizationId: orgId(),
    projectId: projectId(),
    day: date({ mode: 'string' }).notNull(),
    featureId: uuid().references(() => features.id, { onDelete: 'cascade' }),
    configurationId: uuid().references(() => configurations.id, { onDelete: 'cascade' }),
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    total: integer().notNull().default(0),
    passed: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    skipped: integer().notNull().default(0),
    flaky: integer().notNull().default(0),
    durationP50Ms: integer(),
    durationP95Ms: integer(),
    updatedAt: updatedAt(),
  },
  (t) => [index('daily_project_metrics_project_day_idx').on(t.projectId, t.day.desc())],
);

/** Which feature × configuration cells have ever run, and how they last went. */
export const matrixCoverage = pgTable(
  'matrix_coverage',
  {
    organizationId: orgId(),
    projectId: projectId(),
    featureId: uuid()
      .notNull()
      .references(() => features.id, { onDelete: 'cascade' }),
    configurationId: uuid()
      .notNull()
      .references(() => configurations.id, { onDelete: 'cascade' }),
    lastRunAt: ts(),
    lastStatus: resultStatusEnum(),
    runCount: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.featureId, t.configurationId] })],
);

export const triageMetrics = pgTable(
  'triage_metrics',
  {
    organizationId: orgId(),
    projectId: projectId(),
    day: date({ mode: 'string' }).notNull(),
    untriagedCount: integer().notNull().default(0),
    triagedCount: integer().notNull().default(0),
    meanTimeToTriageSeconds: integer(),
    meanTimeToFixSeconds: integer(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
);
