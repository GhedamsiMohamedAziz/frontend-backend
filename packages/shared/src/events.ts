import { z } from 'zod';
import {
  attachmentKindSchema,
  resultStatusSchema,
  runStatusSchema,
  stepKeywordSchema,
  stepStatusSchema,
  type ResultStatus,
  type RunStatus,
} from './enums.js';

/**
 * The ingestion contract.
 *
 * Every adapter (Playwright JSON, JUnit XML, Cucumber, Allure, WDIO, Cypress)
 * normalizes to this union, and both ingestion modes — streaming from the
 * reporter and batch archive upload — produce the same events. That is what
 * keeps one write path in the worker instead of six.
 */

export const configurationInputSchema = z
  .object({
    browser: z.string().max(64).optional(),
    browserVersion: z.string().max(64).optional(),
    device: z.string().max(64).optional(),
    os: z.string().max(64).optional(),
    osVersion: z.string().max(64).optional(),
    viewport: z.string().max(32).optional(),
    locale: z.string().max(32).optional(),
    shardIndex: z.number().int().min(0).optional(),
    shardTotal: z.number().int().min(1).optional(),
    /** Free-form extra dimensions, filterable like the first-class ones. */
    dimensions: z.record(z.string().max(64), z.string().max(256)).default({}),
  })
  .strict();

export type ConfigurationInput = z.infer<typeof configurationInputSchema>;

export const testIdentitySchema = z
  .object({
    filePath: z.string().min(1).max(1024),
    title: z.string().min(1).max(1024),
    fullTitle: z.string().min(1).max(4096),
    params: z.record(z.string(), z.unknown()).default({}),
    suite: z.string().max(512).optional(),
    feature: z.string().max(512).optional(),
    tags: z.array(z.string().max(128)).default([]),
  })
  .strict();

export type TestIdentity = z.infer<typeof testIdentitySchema>;

export const errorInputSchema = z
  .object({
    type: z.string().max(256).optional(),
    message: z.string().max(20_000),
    stack: z.string().max(100_000).optional(),
  })
  .strict();

const base = {
  /** Client-generated, unique per project. This is what makes retries safe. */
  eventId: z.string().uuid(),
  at: z.coerce.date(),
};

export const ingestEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('run.started'),
    startedAt: z.coerce.date(),
  }),
  z.object({
    ...base,
    type: z.literal('run.finished'),
    status: runStatusSchema,
    finishedAt: z.coerce.date(),
  }),
  z.object({
    ...base,
    type: z.literal('config.started'),
    configuration: configurationInputSchema,
    configurationRef: z.string().min(1).max(200),
  }),
  z.object({
    ...base,
    type: z.literal('config.finished'),
    configurationRef: z.string().min(1).max(200),
    status: runStatusSchema,
  }),
  z.object({
    ...base,
    type: z.literal('test.started'),
    configurationRef: z.string().min(1).max(200),
    resultRef: z.string().min(1).max(200),
    test: testIdentitySchema,
    retryIndex: z.number().int().min(0).default(0),
  }),
  z.object({
    ...base,
    type: z.literal('test.finished'),
    resultRef: z.string().min(1).max(200),
    status: resultStatusSchema,
    durationMs: z.number().int().min(0),
    error: errorInputSchema.optional(),
    isFinalAttempt: z.boolean().default(true),
  }),
  z.object({
    ...base,
    type: z.literal('step.finished'),
    resultRef: z.string().min(1).max(200),
    stepRef: z.string().min(1).max(200),
    parentStepRef: z.string().max(200).optional(),
    position: z.number().int().min(0),
    keyword: stepKeywordSchema.optional(),
    title: z.string().min(1).max(2048),
    status: stepStatusSchema,
    durationMs: z.number().int().min(0),
    errorMessage: z.string().max(20_000).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('attachment.added'),
    resultRef: z.string().min(1).max(200),
    stepRef: z.string().max(200).optional(),
    kind: attachmentKindSchema,
    s3Key: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(256),
    sizeBytes: z.number().int().min(0),
    sha256: z.string().length(64),
  }),
]);

export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestEventType = IngestEvent['type'];

/** Events are posted in batches; one HTTP request per test would not scale. */
export const ingestEnvelopeSchema = z
  .object({
    events: z.array(ingestEventSchema).min(1).max(1000),
  })
  .strict();

export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

// ─── Live view ──────────────────────────────────────────────────────────────

/**
 * What the browser receives over SSE.
 *
 * Deliberately not the same union as `IngestEvent`. Ingestion events describe
 * what a runner did; live events describe what changed in the *stored* run,
 * after identities are resolved and errors are clustered. Sending raw ingestion
 * events would make the browser re-derive all of that, and it would leak the
 * reporter's correlation refs into a public contract.
 */
export type LiveEvent =
  | { seq: number; runId: string; at: string; type: 'run.progress'; data: RunProgress }
  | { seq: number; runId: string; at: string; type: 'result.finished'; data: LiveResult }
  | { seq: number; runId: string; at: string; type: 'run.finished'; data: RunProgress };

export interface RunProgress {
  status: RunStatus;
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    broken: number;
    flaky: number;
    running: number;
  };
  /**
   * Best guess at how many results this run will produce, from history.
   * Null when the project has no comparable completed run to learn from.
   */
  expectedTotal: number | null;
  /** Milliseconds remaining, or null while there is not enough signal yet. */
  etaMs: number | null;
  startedAt: string | null;
  configurations: Array<{
    id: string;
    label: string;
    status: RunStatus;
    done: number;
    failed: number;
  }>;
}

/** One finished result, shaped for the live feed rather than for the report. */
export interface LiveResult {
  id: string;
  testCaseId: string;
  title: string;
  fullTitle: string;
  status: ResultStatus;
  durationMs: number;
  configurationId: string;
  configurationLabel: string;
  /** First line of the error, for the failure rail. */
  errorPreview: string | null;
  /** Fetched through the API, which authorizes then redirects to a signed URL. */
  screenshotAttachmentId: string | null;
}

/** Redis stream key holding the replay buffer for one run. */
export const liveStreamKey = (runId: string): string => `live:run:${runId}`;
/** Pub/sub channel used to wake API processes that have subscribers. */
export const liveChannel = (runId: string): string => `live:notify:${runId}`;
