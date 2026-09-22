import { randomUUID } from 'node:crypto';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import {
  attachmentKind,
  attemptStatus,
  configurationFor,
  deriveFeature,
  platformOs,
} from '@eyesonbug/adapters';
import type { PendingAttachment } from '@eyesonbug/adapters';
import {
  normalizeFilePath,
  stripAnsi,
  type IngestEvent,
  type ResultStatus,
} from '@eyesonbug/shared';
import { IngestClient } from './client';
import { resolveConfig, type ReporterConfig } from './config';

export interface EyesOnBugReporterOptions {
  url?: string;
  token?: string;
  environment?: string;
  build?: string;
  /** Repository root, so test paths are repo-relative. Defaults to the git root. */
  root?: string;
  /** How often to push buffered events, in milliseconds. */
  flushIntervalMs?: number;
  /** Push early once this many events are buffered. */
  flushSize?: number;
  /** Set false to keep going silently when EyesOnBug is unreachable. */
  verbose?: boolean;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

/**
 * A Playwright reporter that streams results to EyesOnBug as they happen.
 *
 * The batch CLI (`eyesonbug upload`) reads the JSON report after the suite
 * finishes and is the simplest thing that works. This exists for the case the
 * CLI cannot serve: watching a twenty-minute suite while it runs, and seeing
 * the first failure at minute three rather than minute twenty.
 *
 * Both paths produce the same `IngestEvent` union and, critically, the same
 * test fingerprints — the identity helpers are shared with the adapter — so a
 * project can switch between them without splitting any test's history.
 *
 * Reporting must never be able to fail a customer's test run. Every network
 * error is caught, reported once, and then the reporter goes quiet.
 */
export default class EyesOnBugReporter implements Reporter {
  private readonly options: EyesOnBugReporterOptions;
  private config!: ReporterConfig;
  private client!: IngestClient;

  private runId: string | null = null;
  private runUrl: string | null = null;
  private buffer: IngestEvent[] = [];
  private pendingAttachments: PendingAttachment[] = [];
  private uploadedPaths = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  /** Serialises network work so events are never sent out of sequence. */
  private chain: Promise<void> = Promise.resolve();
  private disabled = false;
  private cancelled = false;
  private startedAt = new Date();

  constructor(options: EyesOnBugReporterOptions = {}) {
    this.options = options;
  }

  /** Playwright keeps its own terminal reporter; this one only talks to the API. */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    try {
      this.config = resolveConfig({
        ...(this.options.url ? { url: this.options.url } : {}),
        ...(this.options.token ? { token: this.options.token } : {}),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
        ...(this.options.build ? { build: this.options.build } : {}),
        ...(this.options.root ? { root: this.options.root } : {}),
      });
      this.client = new IngestClient(this.config);
    } catch (error) {
      // Almost always a missing token. Say so once and let the suite run.
      this.warn((error as Error).message);
      this.disabled = true;
      return;
    }

    this.startedAt = new Date();
    this.enqueue(async () => {
      const run = await this.client.openRun();
      this.runId = run.runId;
      this.runUrl = run.url;
      this.log(`run #${run.number} — ${run.url}`);
    });

    this.push({
      eventId: randomUUID(),
      at: this.startedAt,
      type: 'run.started',
      startedAt: this.startedAt,
    });

    const fallbackOs = platformOs();
    for (const project of config.projects) {
      this.push({
        eventId: randomUUID(),
        at: this.startedAt,
        type: 'config.started',
        configurationRef: `config:${project.name}`,
        configuration: configurationFor(
          { metadata: project.metadata as Record<string, unknown> | undefined },
          project.name,
          fallbackOs,
        ),
      });
    }

    this.flushTimer = setInterval(
      () => this.scheduleFlush(),
      this.options.flushIntervalMs ?? 1_000,
    );
    // Do not hold the process open just to report.
    this.flushTimer.unref?.();
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    if (this.disabled || this.cancelled) return;

    const identity = this.identify(test);
    this.push({
      eventId: randomUUID(),
      at: new Date(),
      type: 'test.started',
      configurationRef: `config:${this.projectName(test)}`,
      resultRef: this.resultRef(test, result),
      retryIndex: result.retry,
      test: identity,
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.disabled || this.cancelled) return;

    const resultRef = this.resultRef(test, result);

    /*
     * Playwright decides a test's verdict only after its retries. At this point
     * we know whether *this* attempt will be retried: a non-passing attempt
     * with retries left is not final. The last attempt of a test that failed
     * then passed carries the `flaky` verdict.
     */
    const willRetry =
      result.status !== 'passed' && result.status !== 'skipped' && result.retry < test.retries;
    const isFinalAttempt = !willRetry;
    const status: ResultStatus =
      isFinalAttempt && test.outcome() === 'flaky' ? 'flaky' : attemptStatus(result.status);

    const error = result.errors[0] ?? result.error;
    const message = error?.message ?? error?.value;

    this.push({
      eventId: randomUUID(),
      at: new Date(),
      type: 'test.finished',
      resultRef,
      status,
      durationMs: Math.max(0, Math.round(result.duration)),
      isFinalAttempt,
      ...(message
        ? {
            error: {
              message: stripAnsi(message).slice(0, 20_000),
              ...(error?.stack
                ? { stack: stripAnsi(error.stack) }
                : error?.location
                  ? {
                      stack: `    at ${this.repoPath(error.location.file)}:${error.location.line}:${error.location.column}`,
                    }
                  : {}),
            },
          }
        : {}),
    });

    for (const [index, step] of result.steps.entries()) {
      if (step.category !== 'test.step') continue;
      this.push({
        eventId: randomUUID(),
        at: new Date(),
        type: 'step.finished',
        resultRef,
        stepRef: `${resultRef}:s${index}`,
        position: index,
        title: step.title.slice(0, 2048),
        status: step.error ? 'failed' : 'passed',
        durationMs: Math.max(0, Math.round(step.duration)),
        ...(step.error?.message ? { errorMessage: stripAnsi(step.error.message) } : {}),
      });
    }

    const attachments: PendingAttachment[] = [];
    for (const attachment of result.attachments) {
      if (!attachment.path) continue;
      const kind = attachmentKind(attachment);
      if (!kind) continue;
      attachments.push({
        resultRef,
        kind,
        contentType: attachment.contentType,
        localPath: attachment.path,
        name: attachment.name,
      });
    }

    /*
     * Screenshots go up straight away because the live view wants a thumbnail
     * beside a failure the moment it appears. Videos and traces are still being
     * written when a test ends — Playwright finalises them later — so they wait
     * for the end of the run.
     */
    const immediate = attachments.filter((a) => a.kind === 'screenshot');
    this.pendingAttachments.push(...attachments.filter((a) => a.kind !== 'screenshot'));
    if (immediate.length > 0) this.uploadLater(immediate);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.disabled) return;
    if (this.flushTimer) clearInterval(this.flushTimer);

    const finishedAt = new Date();
    this.push({
      eventId: randomUUID(),
      at: finishedAt,
      type: 'run.finished',
      status: this.cancelled
        ? 'cancelled'
        : result.status === 'passed'
          ? 'passed'
          : result.status === 'interrupted'
            ? 'cancelled'
            : 'failed',
      finishedAt,
    });

    // Remaining artifacts, now that Playwright has finished writing them.
    this.uploadLater(this.pendingAttachments);
    this.pendingAttachments = [];

    this.enqueue(async () => {
      await this.flushNow();
      if (this.runId) await this.client.complete(this.runId);
    });

    try {
      await this.chain;
      if (this.runUrl) this.log(this.runUrl);
    } catch (error) {
      this.warn(`could not finish reporting: ${(error as Error).message}`);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private push(event: IngestEvent): void {
    if (this.disabled) return;
    this.buffer.push(event);
    if (this.buffer.length >= (this.options.flushSize ?? 100)) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.disabled || this.buffer.length === 0) return;
    this.enqueue(() => this.flushNow());
  }

  private async flushNow(): Promise<void> {
    if (this.disabled || !this.runId || this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    const response = await this.client.sendEvents(this.runId, batch);
    // Cancellation is discovered here rather than by polling: the reporter is
    // already talking to the API once a second.
    if (response.runStatus === 'cancelled' && !this.cancelled) {
      this.cancelled = true;
      this.warn('run was cancelled from EyesOnBug — no further results will be sent');
    }
  }

  private uploadLater(attachments: PendingAttachment[]): void {
    const fresh = attachments.filter((a) => !this.uploadedPaths.has(a.localPath));
    if (fresh.length === 0) return;
    for (const attachment of fresh) this.uploadedPaths.add(attachment.localPath);

    this.enqueue(async () => {
      if (!this.runId) return;
      const events = await this.client.uploadAttachments(this.runId, fresh);
      this.buffer.push(...events);
    });
  }

  /**
   * Every network call runs in one chain.
   *
   * Playwright's hooks are synchronous, so work has to be deferred; doing it in
   * a chain keeps the ordering the worker relies on and stops a slow upload
   * from overlapping the next flush. A failure disables reporting rather than
   * propagating — a broken dashboard must not turn a green suite red.
   */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      if (this.disabled) return;
      this.disabled = true;
      this.warn(`disabled after an error: ${(error as Error).message}`);
    });
  }

  private identify(test: TestCase) {
    const filePath = this.repoPath(test.location.file);
    const describes: string[] = [];
    for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
      // Only `describe` titles: the root, project and file suites would put the
      // project name and the file path inside every test's title.
      if (suite.type === 'describe' && suite.title) describes.unshift(suite.title);
    }

    const fullTitle = [...describes, test.title].join(' > ');
    const tags = test.tags ?? [];
    const annotations = test.annotations
      .map((a) => (a.type ? `@${a.type}${a.description ? `:${a.description}` : ''}` : ''))
      .filter(Boolean);

    return {
      filePath,
      title: test.title,
      fullTitle,
      params: {},
      ...(describes.length > 0 ? { suite: describes.join(' > ') } : {}),
      feature: deriveFeature(filePath, tags, annotations),
      tags,
    };
  }

  private projectName(test: TestCase): string {
    for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
      if (suite.type === 'project' && suite.title) return suite.title;
    }
    return 'default';
  }

  private resultRef(test: TestCase, result: TestResult): string {
    return `${this.repoPath(test.location.file)}|${this.identify(test).fullTitle}|${this.projectName(test)}|${result.retry}`;
  }

  private repoPath(file: string): string {
    const root = toPosix(this.config?.rootDir ?? '').replace(/\/$/, '');
    const absolute = toPosix(file);
    return normalizeFilePath(
      root && absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute,
    );
  }

  private log(message: string): void {
    if (this.options.verbose === false) return;
    process.stdout.write(`  eyesonbug: ${message}\n`);
  }

  private warn(message: string): void {
    process.stderr.write(`  eyesonbug: ${message}\n`);
  }
}
