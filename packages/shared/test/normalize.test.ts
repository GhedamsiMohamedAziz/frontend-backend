import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  deriveErrorType,
  normalizeErrorMessage,
  normalizeFilePath,
  normalizeStackFrames,
  stripAnsi,
} from '../src/normalize.js';

describe('normalizeFilePath', () => {
  it('produces one path for the same test checked out anywhere', () => {
    const expected = 'e2e/checkout.spec.ts';
    expect(normalizeFilePath('e2e/checkout.spec.ts')).toBe(expected);
    expect(normalizeFilePath('./e2e/checkout.spec.ts')).toBe(expected);
    expect(normalizeFilePath('/e2e/checkout.spec.ts')).toBe(expected);
    expect(normalizeFilePath('e2e\\checkout.spec.ts')).toBe(expected);
    expect(normalizeFilePath('C:\\e2e\\checkout.spec.ts')).toBe(expected);
    expect(normalizeFilePath('e2e//checkout.spec.ts')).toBe(expected);
  });
});

describe('canonicalJson', () => {
  it('is insensitive to key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('drops undefined members rather than serializing them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('normalizeErrorMessage', () => {
  it('collapses the same failure seen on two machines at two times', () => {
    const a = normalizeErrorMessage(
      'TimeoutError: locator.click timed out after 30000ms at /home/runner/work/shop/e2e/checkout.spec.ts',
    );
    const b = normalizeErrorMessage(
      'TimeoutError: locator.click timed out after 5000ms at /Users/dev/projects/shop/e2e/checkout.spec.ts',
    );
    expect(a).toBe(b);
  });

  it('strips ids, timestamps, addresses and ports', () => {
    const normalized = normalizeErrorMessage(
      'Failed for order 3f1b0c2e-0a2b-4c3d-8e9f-1a2b3c4d5e6f at 2026-09-22T10:31:02.441Z on http://localhost:4173 (0xdeadbeef)',
    );
    expect(normalized).not.toMatch(/3f1b0c2e/);
    expect(normalized).not.toMatch(/2026-09-22/);
    expect(normalized).not.toMatch(/0xdeadbeef/);
    expect(normalized).toContain(':<port>');
  });

  it('keeps small assertion values distinct, because they are usually different bugs', () => {
    expect(normalizeErrorMessage('expected 3, received 5')).not.toBe(
      normalizeErrorMessage('expected 4, received 6'),
    );
  });

  it('removes ANSI colour codes emitted by runners', () => {
    expect(normalizeErrorMessage('\u001B[31mAssertionError\u001B[39m: nope')).toBe(
      'AssertionError: nope',
    );
  });
});

describe('normalizeStackFrames', () => {
  const stack = [
    'TimeoutError: waiting for locator',
    '    at CheckoutPage.submit (/home/runner/work/shop/e2e/pages/checkout.ts:42:11)',
    '    at /home/runner/work/shop/e2e/checkout.spec.ts:18:5',
    '    at Object.<anonymous> (/home/runner/work/shop/node_modules/@playwright/test/lib/worker.js:9:1)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');

  it('keeps only application frames', () => {
    const frames = normalizeStackFrames(stack);
    expect(frames).toHaveLength(2);
    expect(frames.join('\n')).not.toMatch(/node_modules|node:internal/);
  });

  it('drops line and column numbers so an edit above the failure does not resplit a cluster', () => {
    expect(normalizeStackFrames(stack).join('\n')).not.toMatch(/:\d+:\d+/);
  });

  it('returns an empty list for a missing stack', () => {
    expect(normalizeStackFrames(undefined)).toEqual([]);
    expect(normalizeStackFrames(null)).toEqual([]);
  });
});

describe('deriveErrorType', () => {
  it('prefers the reported type', () => {
    expect(deriveErrorType('TimeoutError', 'AssertionError: x')).toBe('TimeoutError');
  });

  it('recovers the type from the message when the runner omits it', () => {
    expect(deriveErrorType(null, 'AssertionError: expected true')).toBe('AssertionError');
  });

  it('falls back to Error rather than producing an empty type', () => {
    expect(deriveErrorType(null, 'something went wrong')).toBe('Error');
    expect(deriveErrorType('  ', null)).toBe('Error');
  });
});

describe('normalizeErrorMessage — runner noise', () => {
  const playwrightFailure = [
    'Error: expect(locator).toHaveText(expected) failed',
    '',
    "Locator:  getByTestId('price-p1')",
    'Expected: "49,90 €"',
    'Received: "€49.90"',
    'Timeout:  5000ms',
    '',
    'Call log:',
    '  - Expect "toHaveText" with timeout 5000ms',
    "  - waiting for getByTestId('price-p1')",
    '',
    '  32 |',
    "  33 |   if (locale.startsWith('fr')) {",
    "> 34 |     await expect(price).toHaveText('49,90 €');",
    '     |                         ^',
    '  35 |   }',
  ].join('\n');

  it('keeps the description and drops the call log and code frame', () => {
    const normalized = normalizeErrorMessage(playwrightFailure);

    expect(normalized).toContain('toHaveText(expected) failed');
    expect(normalized).toContain('49,90');
    expect(normalized).not.toContain('Call log');
    expect(normalized).not.toContain('locale.startsWith');
  });

  it('survives an edit above the failing line — the whole point of clustering', () => {
    // Two imports added at the top: every line number in the snippet shifts.
    const shifted = playwrightFailure
      .replace('  32 |', '  34 |')
      .replace('  33 |', '  35 |')
      .replace('> 34 |', '> 36 |')
      .replace('  35 |', '  37 |');

    expect(normalizeErrorMessage(shifted)).toBe(normalizeErrorMessage(playwrightFailure));
  });

  it('falls back to the raw message when there is nothing but a stack', () => {
    const stackOnly = '    at CheckoutPage.submit (/app/e2e/checkout.ts:1:1)';
    expect(normalizeErrorMessage(stackOnly).length).toBeGreaterThan(0);
  });
});

describe('stripAnsi', () => {
  it('removes colour codes a runner emits for a terminal', () => {
    expect(stripAnsi('Error: \u001B[2mexpect(\u001B[22m\u001B[31mlocator\u001B[39m) failed')).toBe(
      'Error: expect(locator) failed',
    );
  });

  it('leaves text without escape codes untouched', () => {
    expect(stripAnsi('plain message')).toBe('plain message');
  });
});
