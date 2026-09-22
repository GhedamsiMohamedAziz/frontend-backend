import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IngestEvent } from '@eyesonbug/shared';
import { detectAdapter, parseReport, playwrightAdapter } from '../src/index';

/**
 * Parsed against a report produced by actually running the demo suite in
 * `examples/demo-e2e`, not a hand-written fixture. A fixture I wrote myself
 * would only prove the parser agrees with my idea of Playwright's output.
 */
const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'playwright-demo.json'),
    'utf8',
  ),
) as unknown;

const DEMO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'examples',
  'demo-e2e',
);

// `rootDir` is what the reporter passes: the repository root, so paths in the
// report become repo-relative and a fingerprint means the same thing on every
// machine.
const parsed = playwrightAdapter.parse(fixture, { rootDir: DEMO_ROOT });
const byType = <T extends IngestEvent['type']>(type: T) =>
  parsed.events.filter((event): event is Extract<IngestEvent, { type: T }> => event.type === type);

describe('detection', () => {
  it('recognises a Playwright JSON report', () => {
    expect(detectAdapter(fixture)?.name).toBe('playwright-json');
  });

  it('does not claim a report it cannot parse', () => {
    expect(detectAdapter({ testsuites: [] })).toBeNull();
    expect(detectAdapter(null)).toBeNull();
    expect(detectAdapter('<xml/>')).toBeNull();
  });

  it('refuses an unknown format loudly rather than producing an empty run', () => {
    expect(() => parseReport({ nope: true })).toThrow(/Unrecognised report format/);
  });
});

describe('run shape', () => {
  it('brackets the run with a start and a finish', () => {
    expect(byType('run.started')).toHaveLength(1);
    expect(byType('run.finished')).toHaveLength(1);
    expect(byType('run.finished')[0]!.status).toBe('failed');
  });

  it('emits one configuration per Playwright project', () => {
    const configs = byType('config.started');
    expect(configs.map((c) => c.configurationRef).sort()).toEqual([
      'config:chromium-en',
      'config:chromium-fr',
    ]);
  });

  it('carries the locale, which is what makes the matrix meaningful', () => {
    const configs = byType('config.started');
    const locales = configs.map((c) => c.configuration.locale).sort();
    expect(locales).toEqual(['en-US', 'fr-FR']);
    expect(configs.every((c) => c.configuration.browser === 'chromium')).toBe(true);
  });

  it('summarises what the demo suite is designed to produce', () => {
    // 19 passed, 1 failed, 2 flaky, 2 skipped — see the suite's own output.
    expect(parsed.summary).toMatchObject({
      passed: 19,
      failed: 1,
      flaky: 2,
      skipped: 2,
      configurations: 2,
    });
  });
});

describe('results', () => {
  it('records every attempt, not just the last', () => {
    const flakyAttempts = byType('test.finished').filter((event) =>
      event.resultRef.includes('updates the quantity'),
    );
    // Two configurations × two attempts each: the retry evidence is the signal.
    expect(flakyAttempts).toHaveLength(4);
    expect(flakyAttempts.filter((a) => a.isFinalAttempt)).toHaveLength(2);
    expect(flakyAttempts.filter((a) => a.status === 'failed')).toHaveLength(2);
    expect(flakyAttempts.filter((a) => a.status === 'flaky')).toHaveLength(2);
  });

  it('fails the locale test on fr-FR only', () => {
    const priceTests = byType('test.finished').filter((event) =>
      event.resultRef.includes('shows prices in the local format'),
    );
    const failed = priceTests.filter((t) => t.status === 'failed');
    const passed = priceTests.filter((t) => t.status === 'passed');

    // Retries mean the fr-FR failure contributes two attempts, and both are
    // kept. Every failure is fr, every pass is en — that is the point.
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((t) => t.resultRef.includes('chromium-fr'))).toBe(true);
    expect(passed.every((t) => t.resultRef.includes('chromium-en'))).toBe(true);
    expect(failed.filter((t) => t.isFinalAttempt)).toHaveLength(1);
  });

  it('captures the error message, and synthesizes a frame from the location', () => {
    const failure = byType('test.finished').find(
      (event) => event.status === 'failed' && event.resultRef.includes('local format'),
    );
    expect(failure?.error?.message).toMatch(/49,90|toHaveText/);
    // Playwright supplies `location`, not a stack string. The adapter builds a
    // frame from it so failures still have something to cluster on.
    expect(failure?.error?.stack).toContain('e2e/checkout/checkout.spec.ts');
  });

  it('keeps a stable identity for the same test across configurations', () => {
    const started = byType('test.started').filter((event) =>
      event.test.fullTitle.includes('shows prices in the local format'),
    );
    const identities = new Set(started.map((e) => `${e.test.filePath}|${e.test.fullTitle}`));
    // One identity, two configurations — this is what lets history follow a
    // test across the matrix instead of splitting into two timelines.
    expect(identities.size).toBe(1);
    expect([...identities][0]).toBe(
      'e2e/checkout/checkout.spec.ts|Checkout > shows prices in the local format',
    );
  });

  it('attributes tests to a feature from the path convention', () => {
    const features = new Set(byType('test.started').map((event) => event.test.feature));
    expect([...features].sort()).toEqual(['cart', 'checkout', 'search']);
  });

  it('records skipped tests rather than dropping them', () => {
    const skipped = byType('test.finished').filter((event) => event.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe('attachments', () => {
  it('collects screenshots, videos and traces for failures', () => {
    const kinds = new Set(parsed.attachments.map((a) => a.kind));
    expect(kinds).toContain('screenshot');
    expect(kinds).toContain('video');
    expect(kinds).toContain('trace');
  });

  it('leaves them as local paths for the reporter to upload', () => {
    // Parsing stays pure: no filesystem, no network, no S3 keys invented here.
    expect(parsed.attachments.every((a) => a.localPath.length > 0)).toBe(true);
    expect(parsed.events.some((e) => e.type === 'attachment.added')).toBe(false);
  });

  it('ties every attachment to a result that exists', () => {
    const resultRefs = new Set(byType('test.finished').map((event) => event.resultRef));
    for (const attachment of parsed.attachments) {
      expect(resultRefs.has(attachment.resultRef)).toBe(true);
    }
  });
});

describe('idempotency', () => {
  it('gives every event a unique id, so retries can be deduplicated', () => {
    const ids = parsed.events.map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
