import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  attachmentKindEnum,
  createdAt,
  primaryId,
  rerunKindEnum,
  resultStatusEnum,
  runStatusEnum,
  runTriggerEnum,
  stepKeywordEnum,
  stepStatusEnum,
  ts,
} from './_shared';
import { apiTokens, environments, organizations, projects, users } from './tenancy';
import { testCases } from './taxonomy';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

const projectId = () =>
  uuid()
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

/** `ltree` gives us a whole step subtree in one indexed query. */
const ltree = customType<{ data: string }>({ dataType: () => 'ltree' });

/**
 * A matrix cell — browser × device × os × locale × free-form dimensions —
 * reused across runs rather than re-created per run.
 *
 * Stable identity is what makes "which feature × locale × browser combinations
 * have never been run" answerable at all: without it there is nothing to
 * compare this run's cells against.
 */
export const configurations = pgTable(
  'configuration',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    fingerprint: text().notNull(),
    browser: text(),
    browserVersion: text(),
    device: text(),
    os: text(),
    osVersion: text(),
    viewport: text(),
    /** The locale the *tests* ran under, not the UI language of EyesOnBug. */
    locale: text(),
    dimensions: jsonb().$type<Record<string, string>>().notNull().default({}),
    firstSeenAt: createdAt(),
  },
  (t) => [
    uniqueIndex('configuration_project_fingerprint_key').on(t.projectId, t.fingerprint),
    index('configuration_project_browser_idx').on(t.projectId, t.browser),
    index('configuration_project_locale_idx').on(t.projectId, t.locale),
  ],
);

export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  broken: number;
  flaky: number;
  running: number;
}

export const EMPTY_TOTALS: RunTotals = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  broken: 0,
  flaky: 0,
  running: 0,
};

/**
 * One execution (ADR-006).
 *
 * A GitHub matrix produces one Run with many `run_configuration` rows, mirroring
 * `workflow_run` → `workflow_job`. `parentRunId` is reserved and unused; reruns
 * link back through `rerunOfRunId` instead, so a rerun records what it re-ran
 * without claiming to be a child of it.
 */
export interface RunGate {
  gateId: string;
  name: string;
  passed: boolean;
  reasons: string[];
}

export const runs = pgTable(
  'run',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    /** Human-facing, per project: "run #412". */
    number: integer().notNull(),
    status: runStatusEnum().notNull().default('queued'),
    trigger: runTriggerEnum().notNull().default('api'),

    branch: text(),
    commitSha: text(),
    commitMessage: text(),
    commitAuthor: text(),
    buildVersion: text(),
    environmentId: uuid().references(() => environments.id, { onDelete: 'set null' }),

    githubWorkflowRunId: bigint({ mode: 'number' }),
    githubWorkflowName: text(),
    githubRunAttempt: integer(),

    parentRunId: uuid(),
    rerunOfRunId: uuid(),
    rerunKind: rerunKindEnum(),

    /** Set when the run was dispatched from here (M3): what launched it and with what. */
    workflowConfigId: uuid(),
    scheduleId: uuid(),
    dispatchInputs: jsonb().$type<Record<string, string>>(),
    /** Quality gate verdict, written by the worker when the run seals. */
    gate: jsonb().$type<RunGate>(),
    githubCheckRunId: bigint({ mode: 'number' }),

    triggeredByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    triggeredByTokenId: uuid().references(() => apiTokens.id, { onDelete: 'set null' }),

    queuedAt: createdAt(),
    startedAt: ts(),
    finishedAt: ts(),
    durationMs: integer(),

    /** Denormalized counters, authoritative only once the run is sealed. */
    totals: jsonb().$type<RunTotals>().notNull().default(EMPTY_TOTALS),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex('run_project_number_key').on(t.projectId, t.number),
    index('run_project_started_idx').on(t.projectId, t.startedAt.desc()),
    index('run_project_branch_started_idx').on(t.projectId, t.branch, t.startedAt.desc()),
    index('run_github_workflow_run_idx').on(t.githubWorkflowRunId),
    index('run_rerun_of_idx').on(t.rerunOfRunId),
  ],
);

export const runConfigurations = pgTable(
  'run_configuration',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    configurationId: uuid()
      .notNull()
      .references(() => configurations.id, { onDelete: 'restrict' }),
    /**
     * The reporter's correlation key for this configuration.
     *
     * Streaming ingestion processes a run in many passes, and `config.started`
     * arrives in only one of them. Without a durable ref, every later pass
     * would fail to attach its results to a configuration.
     */
    ref: text(),
    status: runStatusEnum().notNull().default('queued'),
    shardIndex: integer(),
    shardTotal: integer(),
    githubJobId: bigint({ mode: 'number' }),
    startedAt: ts(),
    finishedAt: ts(),
    totals: jsonb().$type<RunTotals>().notNull().default(EMPTY_TOTALS),
  },
  (t) => [
    index('run_configuration_run_idx').on(t.runId),
    index('run_configuration_ref_idx').on(t.runId, t.ref),
    uniqueIndex('run_configuration_run_config_shard_key').on(
      t.runId,
      t.configurationId,
      t.shardIndex,
    ),
  ],
);

/**
 * TestCase × Run × Configuration × attempt.
 *
 * Partitioned monthly on `started_at` (ADR-012), so retention detaches a
 * partition instead of deleting hundreds of millions of rows, and so the
 * primary key must include the partition key.
 *
 * Every retry is its own row. Nothing is overwritten: the record of a retry
 * *is* the flakiness evidence, and losing it would make the signal
 * unreconstructable.
 */
export const testResults = pgTable(
  'test_result',
  {
    id: uuid().notNull(),
    organizationId: orgId(),
    projectId: projectId(),
    runId: uuid()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    runConfigurationId: uuid()
      .notNull()
      .references(() => runConfigurations.id, { onDelete: 'cascade' }),
    testCaseId: uuid()
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),

    /**
     * The reporter's correlation key for this attempt, for the same reason as
     * `run_configuration.ref`: `test.started` and `test.finished` routinely
     * land in different batches, and the row created by the first has to be
     * findable by the second.
     *
     * Not unique: a unique index on a partitioned table must contain the
     * partition key, and `started_at` has no business being in a correlation
     * key. Uniqueness comes from event deduplication instead.
     */
    resultRef: text(),
    status: resultStatusEnum().notNull(),
    retryIndex: integer().notNull().default(0),
    isFinalAttempt: boolean().notNull().default(true),
    durationMs: integer().notNull().default(0),
    startedAt: ts().notNull(),
    finishedAt: ts(),

    errorType: text(),
    errorMessage: text(),
    stackTrace: text(),
    normalizedStack: text(),
    errorSignatureId: uuid(),

    /** True when the test was under quarantine at the time it ran. */
    wasQuarantined: boolean().notNull().default(false),
    workerId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.startedAt] }),
    index('test_result_case_started_idx').on(t.projectId, t.testCaseId, t.startedAt.desc()),
    index('test_result_run_idx').on(t.runId),
    index('test_result_run_ref_idx').on(t.runId, t.resultRef),
    index('test_result_run_config_case_idx').on(t.runConfigurationId, t.testCaseId),
    index('test_result_signature_idx').on(t.projectId, t.errorSignatureId, t.startedAt.desc()),
  ],
);

/**
 * Nested steps (Given/When/Then for BDD).
 *
 * No foreign key to `test_result`: the parent is partitioned and its unique key
 * is composite, so a single-column reference is not expressible, and a FK would
 * in any case block detaching an old partition. Referential integrity is the
 * worker's responsibility, and retention deletes steps by `started_at` on the
 * same schedule as the results they belong to.
 */
export const steps = pgTable(
  'step',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    testResultId: uuid().notNull(),
    parentStepId: uuid(),
    /** Materialized path, so one query returns a whole subtree in order. */
    path: ltree().notNull(),
    position: integer().notNull(),
    keyword: stepKeywordEnum(),
    title: text().notNull(),
    status: stepStatusEnum().notNull(),
    durationMs: integer().notNull().default(0),
    errorMessage: text(),
    startedAt: ts().notNull(),
  },
  (t) => [
    index('step_result_position_idx').on(t.testResultId, t.position),
    index('step_started_idx').on(t.startedAt),
  ],
);

export const attachments = pgTable(
  'attachment',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    testResultId: uuid(),
    stepId: uuid(),
    kind: attachmentKindEnum().notNull(),
    /** Object key in S3. Bytes never pass through the API (ADR-008). */
    s3Key: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    sha256: text().notNull(),
    width: integer(),
    height: integer(),
    createdAt: createdAt(),
    /** Set from the project's retention policy; the reaper sweeps on this. */
    expiresAt: ts(),
  },
  (t) => [
    index('attachment_result_kind_idx').on(t.testResultId, t.kind),
    index('attachment_expires_idx').on(t.expiresAt),
  ],
);

/**
 * The idempotency ledger (ADR-008). A retried CI step replays byte-identical
 * requests; the unique key turns the second attempt into a no-op instead of a
 * duplicate run.
 */
export const ingestEvents = pgTable(
  'ingest_event',
  {
    id: primaryId(),
    organizationId: orgId(),
    projectId: projectId(),
    idempotencyKey: text().notNull(),
    runId: uuid().references(() => runs.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    receivedAt: createdAt(),
    processedAt: ts(),
    failedAt: ts(),
    error: text(),
  },
  (t) => [
    uniqueIndex('ingest_event_project_key_key').on(t.projectId, t.idempotencyKey),
    index('ingest_event_unprocessed_idx').on(t.receivedAt),
  ],
);
