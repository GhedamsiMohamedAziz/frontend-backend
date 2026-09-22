import { randomUUID } from 'node:crypto';
import {
  normalizeFilePath,
  stripAnsi,
  type IngestEvent,
  type ResultStatus,
} from '@eyesonbug/shared';
import type { Adapter, AdapterContext, ParsedReport, PendingAttachment } from './types';

/**
 * Playwright's `json` reporter.
 *
 * Shape (abridged, from Playwright 1.4x):
 *   { config: { projects: [{ id, name, use: { browserName, locale, ... } }] },
 *     suites: [ { title, file, specs: [...], suites: [...] } ],
 *     stats: { startTime, duration, expected, unexpected, flaky, skipped } }
 *
 * Only the fields we actually read are typed. Playwright adds fields between
 * minor releases, and a parser that insists on an exact shape would break on
 * every upgrade of a dependency we do not control.
 */

interface PwLocation {
  file?: string;
  line?: number;
  column?: number;
}

interface PwError {
  message?: string;
  /** Usually absent: Playwright reports `location` instead of a stack string. */
  stack?: string;
  value?: string;
  location?: PwLocation;
}

interface PwStep {
  title?: string;
  duration?: number;
  error?: PwError;
  steps?: PwStep[];
  category?: string;
}

interface PwAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}

interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  startTime?: string;
  workerIndex?: number;
  errors?: PwError[];
  error?: PwError;
  attachments?: PwAttachment[];
  steps?: PwStep[];
}

interface PwTest {
  projectId?: string;
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  results?: PwResult[];
  annotations?: Array<{ type?: string; description?: string }>;
}

interface PwSpec {
  title?: string;
  file?: string;
  line?: number;
  tags?: string[];
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwProject {
  id?: string;
  name?: string;
  testDir?: string;
  /**
   * Playwright's JSON reporter does NOT serialize a project's `use` block, so
   * browserName, locale and viewport are simply not in the report. `metadata`
   * IS serialized, which makes it the supported way to declare configuration
   * dimensions — see `configurationFor`.
   */
  metadata?: Record<string, unknown>;
}

interface PwReport {
  config?: { projects?: PwProject[]; rootDir?: string; version?: string };
  suites?: PwSuite[];
  stats?: {
    startTime?: string;
    duration?: number;
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
}

/**
 * Playwright reports two different statuses per test and they answer different
 * questions. `result.status` is what one *attempt* did; `test.status` is the
 * verdict after retries ('expected' | 'unexpected' | 'flaky' | 'skipped').
 * We keep every attempt as its own row and let the final one carry the verdict,
 * because the record of a retry is the flakiness evidence.
 */
export function attemptStatus(raw: string | undefined): ResultStatus {
  switch (raw) {
    case 'passed':
      return 'passed';
    case 'skipped':
      return 'skipped';
    case 'timedOut':
      // A timeout is a failure, not a separate category: it clusters with other
      // failures by error signature, which is where it is most useful.
      return 'failed';
    case 'interrupted':
      // The run was cut short; the test never reached a verdict of its own.
      return 'broken';
    case 'failed':
    default:
      return 'failed';
  }
}

/**
 * Playwright rarely provides a stack string; it provides a structured
 * `location` instead. The error signature needs *some* frame to cluster on, so
 * one is synthesized from the location. Line and column are included even
 * though normalization strips them, because the raw value is still what a
 * human wants to see in the report.
 */
function collectError(
  result: PwResult,
  toRepoPath: (file: string) => string,
): { type?: string; message: string; stack?: string } | null {
  const error = result.errors?.[0] ?? result.error;
  if (!error) return null;

  // Stored for display, so the terminal colour codes come off here rather than
  // leaving every reader to cope with them.
  const message = stripAnsi(error.message ?? error.value ?? 'Test failed');
  let stack = error.stack ? stripAnsi(error.stack) : undefined;
  if (!stack && error.location?.file) {
    const file = toRepoPath(error.location.file);
    stack = `    at ${file}:${error.location.line ?? 0}:${error.location.column ?? 0}`;
  }

  return { message, ...(stack ? { stack } : {}) };
}

export function attachmentKind(attachment: {
  name?: string;
  contentType?: string;
  path?: string;
}): PendingAttachment['kind'] | null {
  const name = (attachment.name ?? '').toLowerCase();
  const type = (attachment.contentType ?? '').toLowerCase();

  if (name === 'trace' || attachment.path?.endsWith('trace.zip')) return 'trace';
  if (type.startsWith('image/')) return 'screenshot';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/har+json' || name.includes('har')) return 'har';
  if (type.startsWith('text/') || type === 'application/json') return 'log';
  return null;
}

/**
 * Feature attribution, in order of how explicit the signal is:
 *   1. a `@feature:checkout` annotation or tag — the author said so;
 *   2. the first directory below the tests root — a path convention;
 *   3. the spec file's own name.
 * Guessing is fine here as long as it is predictable and can be overridden.
 */
export function deriveFeature(filePath: string, tags: string[], annotations: string[]): string {
  const explicit = [...tags, ...annotations].find((value) => value.startsWith('@feature:'));
  if (explicit) return explicit.slice('@feature:'.length);

  const segments = filePath.split('/').filter(Boolean);
  if (segments.length > 1) return segments[segments.length - 2]!;

  const file = segments[segments.length - 1] ?? filePath;
  return file.replace(/\.(spec|test)\.[tj]sx?$/, '');
}

function flattenSteps(
  steps: PwStep[] | undefined,
  resultRef: string,
  startedAt: Date,
  eventAt: Date,
  parentRef: string | undefined,
  out: IngestEvent[],
  counter: { value: number },
  depth = 0,
): void {
  // Two levels is enough for a Given/When/Then trail. Playwright nests deeply
  // (every expect and every locator call is a step) and storing all of it would
  // multiply row count for no reader benefit.
  if (!steps || depth > 1) return;

  for (const step of steps) {
    const title = step.title?.trim();
    if (!title) continue;
    // `hook` and `pw:api` steps are framework noise, not test narrative.
    if (step.category && !['test.step', 'expect'].includes(step.category)) {
      flattenSteps(step.steps, resultRef, startedAt, eventAt, parentRef, out, counter, depth);
      continue;
    }

    const stepRef = `${resultRef}:s${counter.value}`;
    const position = counter.value;
    counter.value += 1;

    out.push({
      eventId: randomUUID(),
      at: eventAt,
      type: 'step.finished',
      resultRef,
      stepRef,
      ...(parentRef ? { parentStepRef: parentRef } : {}),
      position,
      title: title.slice(0, 2048),
      status: step.error ? 'failed' : 'passed',
      durationMs: Math.max(0, Math.round(step.duration ?? 0)),
      ...(step.error?.message ? { errorMessage: step.error.message.slice(0, 20_000) } : {}),
    });

    flattenSteps(step.steps, resultRef, startedAt, eventAt, stepRef, out, counter, depth + 1);
  }
}

const KNOWN_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const DIMENSION_KEYS = [
  'browser',
  'browserVersion',
  'device',
  'os',
  'osVersion',
  'viewport',
  'locale',
] as const;

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Work out what configuration a Playwright project represents.
 *
 * Because the JSON reporter drops `use`, the report genuinely does not contain
 * the browser or locale a project ran with. Two sources are left, in order:
 *
 *   1. the project's `metadata`, which IS serialized — the supported way to
 *      say "this project is chromium at fr-FR", and the only one that can
 *      describe several projects differently in a single run;
 *   2. the project name, for the common case where it already reads
 *      `chromium-fr` and nobody wants to annotate anything.
 *
 * Anything still unknown is left unset rather than guessed. A wrong dimension
 * is worse than a missing one: it silently splits a test's history in two.
 */
export function configurationFor(
  project: { metadata?: Record<string, unknown> } | undefined,
  projectName: string,
  fallbackOs: string,
) {
  const metadata = project?.metadata;
  const lower = projectName.toLowerCase();

  const browser =
    metadataString(metadata, 'browser') ?? KNOWN_BROWSERS.find((name) => lower.includes(name));

  const dimensions: Record<string, string> = { project: projectName };
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value !== 'string') continue;
    if ((DIMENSION_KEYS as readonly string[]).includes(key)) continue;
    dimensions[key] = value;
  }

  return {
    ...(browser ? { browser } : {}),
    ...(metadataString(metadata, 'browserVersion')
      ? { browserVersion: metadataString(metadata, 'browserVersion')! }
      : {}),
    ...(metadataString(metadata, 'device') ? { device: metadataString(metadata, 'device')! } : {}),
    ...(metadataString(metadata, 'locale') ? { locale: metadataString(metadata, 'locale')! } : {}),
    ...(metadataString(metadata, 'viewport')
      ? { viewport: metadataString(metadata, 'viewport')! }
      : {}),
    os: metadataString(metadata, 'os') ?? fallbackOs,
    ...(metadataString(metadata, 'osVersion')
      ? { osVersion: metadataString(metadata, 'osVersion')! }
      : {}),
    dimensions,
  };
}

const toPosix = (value: string): string => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
const isAbsolutePath = (value: string): boolean => /^(\/|[a-zA-Z]:\/)/.test(toPosix(value));

/**
 * Playwright reports `spec.file` relative to `config.rootDir` (the test
 * directory), so a report on its own says `cart/cart.spec.ts` — which is not
 * where the file lives in the repository.
 *
 * Fingerprints are built from this path, so it has to mean the same thing on
 * every machine. The reporter passes the repository root and we resolve
 * against it; without one we fall back to test-dir-relative, which is at least
 * consistent across checkouts even if it drops a directory.
 */
function repoRelative(file: string, testRoot: string, repoRoot: string | undefined): string {
  const absolute = isAbsolutePath(file)
    ? toPosix(file)
    : testRoot
      ? `${toPosix(testRoot).replace(/\/$/, '')}/${toPosix(file)}`
      : toPosix(file);

  for (const root of [repoRoot, testRoot]) {
    if (!root) continue;
    const base = toPosix(root).replace(/\/$/, '');
    if (absolute.startsWith(`${base}/`)) return normalizeFilePath(absolute.slice(base.length + 1));
  }
  return normalizeFilePath(absolute);
}

export function platformOs(): string {
  return process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : 'linux';
}

export const playwrightAdapter: Adapter = {
  name: 'playwright-json',

  detect(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const report = raw as PwReport;
    return Array.isArray(report.suites) && typeof report.config === 'object';
  },

  parse(raw: unknown, context: AdapterContext = {}): ParsedReport {
    const report = raw as PwReport;
    const events: IngestEvent[] = [];
    const attachments: PendingAttachment[] = [];

    const testRoot = report.config?.rootDir ?? '';
    const toRepoPath = (file: string): string => repoRelative(file, testRoot, context.rootDir);
    const fallbackOs = platformOs();

    const startedAt = report.stats?.startTime ? new Date(report.stats.startTime) : new Date();
    const durationMs = Math.max(0, Math.round(report.stats?.duration ?? 0));
    const finishedAt = new Date(startedAt.getTime() + durationMs);

    events.push({ eventId: randomUUID(), at: startedAt, type: 'run.started', startedAt });

    const projects = new Map<string, PwProject>();
    for (const project of report.config?.projects ?? []) {
      if (project.id) projects.set(project.id, project);
      if (project.name) projects.set(project.name, project);
    }

    const seenConfigs = new Set<string>();
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };

    const walk = (suite: PwSuite, titlePath: string[], file: string | undefined): void => {
      const nextFile = suite.file ?? file;
      // The outermost suite per file is titled with the file path, which would
      // otherwise appear inside every test's full title.
      const isFileSuite = suite.title !== undefined && suite.title === suite.file;
      const nextPath = isFileSuite || !suite.title ? titlePath : [...titlePath, suite.title];

      for (const spec of suite.specs ?? []) {
        const specFile = spec.file ?? nextFile ?? 'unknown.spec.ts';
        const filePath = toRepoPath(specFile);
        const title = spec.title ?? '(untitled)';
        const fullTitle = [...nextPath, title].join(' > ');

        for (const test of spec.tests ?? []) {
          const projectName = test.projectName ?? test.projectId ?? 'default';
          const configurationRef = `config:${projectName}`;

          if (!seenConfigs.has(configurationRef)) {
            seenConfigs.add(configurationRef);
            events.push({
              eventId: randomUUID(),
              at: startedAt,
              type: 'config.started',
              configurationRef,
              configuration: configurationFor(
                projects.get(projectName) ?? projects.get(test.projectId ?? ''),
                projectName,
                fallbackOs,
              ),
            });
          }

          const annotations = (test.annotations ?? [])
            .map((a) => (a.type ? `@${a.type}${a.description ? `:${a.description}` : ''}` : ''))
            .filter(Boolean);
          const tags = (spec.tags ?? []).map((tag) => (tag.startsWith('@') ? tag : `@${tag}`));
          const feature = deriveFeature(filePath, tags, annotations);

          const results = test.results ?? [];
          const lastIndex = results.length - 1;

          for (const [index, result] of results.entries()) {
            const resultRef = `${filePath}|${fullTitle}|${projectName}|${index}`;
            const isFinal = index === lastIndex;
            const resultStartedAt = result.startTime ? new Date(result.startTime) : startedAt;

            events.push({
              eventId: randomUUID(),
              at: resultStartedAt,
              type: 'test.started',
              configurationRef,
              resultRef,
              retryIndex: result.retry ?? index,
              test: {
                filePath,
                title,
                fullTitle,
                params: {},
                ...(nextPath.length > 0 ? { suite: nextPath.join(' > ') } : {}),
                feature,
                tags,
              },
            });

            // Playwright's per-attempt status does not know about retries;
            // only the test-level verdict does. A test that failed then passed
            // is flaky, and that is a property of the last attempt.
            const status: ResultStatus =
              isFinal && test.status === 'flaky' ? 'flaky' : attemptStatus(result.status);
            const error = collectError(result, toRepoPath);
            const resultDuration = Math.max(0, Math.round(result.duration ?? 0));

            events.push({
              eventId: randomUUID(),
              at: new Date(resultStartedAt.getTime() + resultDuration),
              type: 'test.finished',
              resultRef,
              status,
              durationMs: resultDuration,
              isFinalAttempt: isFinal,
              ...(error ? { error } : {}),
            });

            // Playwright's JSON reporter does not serialize steps at all, so
            // this produces nothing today. It stays because the streaming
            // reporter in M2 gets steps from `onStepEnd`, and because other
            // adapters (Cucumber, Allure) carry them in their batch format.
            flattenSteps(
              result.steps,
              resultRef,
              resultStartedAt,
              new Date(resultStartedAt.getTime() + resultDuration),
              undefined,
              events,
              { value: 0 },
            );

            for (const attachment of result.attachments ?? []) {
              if (!attachment.path) continue;
              const kind = attachmentKind(attachment);
              if (!kind) continue;
              attachments.push({
                resultRef,
                kind,
                contentType: attachment.contentType ?? 'application/octet-stream',
                localPath: attachment.path,
                name: attachment.name ?? kind,
              });
            }

            if (isFinal) {
              summary.total += 1;
              if (status === 'passed') summary.passed += 1;
              else if (status === 'skipped') summary.skipped += 1;
              else if (status === 'flaky') summary.flaky += 1;
              else summary.failed += 1;
            }
          }
        }
      }

      for (const child of suite.suites ?? []) walk(child, nextPath, nextFile);
    };

    for (const suite of report.suites ?? []) walk(suite, [], suite.file);

    for (const configurationRef of seenConfigs) {
      events.push({
        eventId: randomUUID(),
        at: finishedAt,
        type: 'config.finished',
        configurationRef,
        status: summary.failed > 0 ? 'failed' : 'passed',
      });
    }

    events.push({
      eventId: randomUUID(),
      at: finishedAt,
      type: 'run.finished',
      status: summary.failed > 0 ? 'failed' : 'passed',
      finishedAt,
    });

    return {
      events,
      attachments,
      summary: {
        startedAt,
        finishedAt,
        durationMs,
        configurations: seenConfigs.size,
        ...summary,
      },
    };
  },
};
