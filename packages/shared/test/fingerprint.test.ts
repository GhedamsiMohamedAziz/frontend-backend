import { describe, expect, it } from 'vitest';
import { buildErrorSignature, configurationFingerprint, testCaseFingerprint } from '../src/node.js';

const PROJECT = '00000000-0000-7000-8000-000000000001';
const OTHER_PROJECT = '00000000-0000-7000-8000-000000000002';

describe('testCaseFingerprint', () => {
  const base = {
    projectId: PROJECT,
    filePath: 'e2e/checkout.spec.ts',
    fullTitle: 'Checkout > pays with a saved card',
  };

  it('is stable across reruns', () => {
    expect(testCaseFingerprint(base)).toBe(testCaseFingerprint({ ...base }));
  });

  it('survives a different CI working directory', () => {
    expect(testCaseFingerprint({ ...base, filePath: './e2e/checkout.spec.ts' })).toBe(
      testCaseFingerprint(base),
    );
  });

  it('is scoped per project so two projects cannot collide', () => {
    expect(testCaseFingerprint({ ...base, projectId: OTHER_PROJECT })).not.toBe(
      testCaseFingerprint(base),
    );
  });

  it('separates parameter sets but ignores their key order', () => {
    const fr = testCaseFingerprint({ ...base, params: { locale: 'fr-FR', tier: 'gold' } });
    const frReordered = testCaseFingerprint({ ...base, params: { tier: 'gold', locale: 'fr-FR' } });
    const de = testCaseFingerprint({ ...base, params: { locale: 'de-DE', tier: 'gold' } });

    expect(fr).toBe(frReordered);
    expect(fr).not.toBe(de);
  });

  it('changes when the test is renamed — which is why test_case_alias exists', () => {
    expect(testCaseFingerprint({ ...base, fullTitle: 'Checkout > pays with a new card' })).not.toBe(
      testCaseFingerprint(base),
    );
  });
});

describe('buildErrorSignature', () => {
  it('clusters the same failure from two different tests', () => {
    const a = buildErrorSignature(PROJECT, {
      errorType: 'TimeoutError',
      message: 'locator.click timed out after 30000ms',
      stack: '    at CheckoutPage.submit (/home/runner/shop/e2e/pages/checkout.ts:42:11)',
    });
    const b = buildErrorSignature(PROJECT, {
      errorType: 'TimeoutError',
      message: 'locator.click timed out after 15000ms',
      stack: '    at CheckoutPage.submit (/Users/dev/shop/e2e/pages/checkout.ts:44:11)',
    });

    expect(a.hash).toBe(b.hash);
  });

  it('keeps genuinely different failures apart', () => {
    const timeout = buildErrorSignature(PROJECT, {
      errorType: 'TimeoutError',
      message: 'locator.click timed out',
    });
    const assertion = buildErrorSignature(PROJECT, {
      errorType: 'AssertionError',
      message: 'expected cart to be empty',
    });

    expect(timeout.hash).not.toBe(assertion.hash);
  });

  it('exposes the human-readable parts alongside the hash', () => {
    const signature = buildErrorSignature(PROJECT, {
      errorType: 'TimeoutError',
      message: 'timed out after 30000ms',
    });
    expect(signature.errorType).toBe('TimeoutError');
    expect(signature.normalizedMessage).toContain('<duration>');
  });
});

describe('configurationFingerprint', () => {
  it('reuses one identity for the same matrix cell across runs', () => {
    const cell = { browser: 'chromium', os: 'linux', locale: 'fr-FR' };
    expect(configurationFingerprint(PROJECT, cell)).toBe(configurationFingerprint(PROJECT, cell));
  });

  it('treats a missing dimension and an explicit null as the same cell', () => {
    expect(configurationFingerprint(PROJECT, { browser: 'chromium' })).toBe(
      configurationFingerprint(PROJECT, { browser: 'chromium', device: null }),
    );
  });

  it('distinguishes locales, which is what makes matrix coverage meaningful', () => {
    expect(configurationFingerprint(PROJECT, { browser: 'chromium', locale: 'fr-FR' })).not.toBe(
      configurationFingerprint(PROJECT, { browser: 'chromium', locale: 'de-DE' }),
    );
  });
});

describe('uuidv7', () => {
  it('produces a valid v7 uuid', async () => {
    const { uuidv7 } = await import('../src/node.js');
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts by creation time, which is why the schema uses it', async () => {
    const { uuidv7 } = await import('../src/node.js');
    const first = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = uuidv7();
    expect(first < second).toBe(true);
  });

  it('does not collide within the same millisecond', async () => {
    const { uuidv7 } = await import('../src/node.js');
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()));
    expect(ids.size).toBe(5000);
  });
});
