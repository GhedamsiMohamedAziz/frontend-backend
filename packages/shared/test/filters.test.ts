import { describe, expect, it } from 'vitest';
import {
  isEmptyFilters,
  parseRunFilters,
  serializeRunFilters,
  paginationSchema,
} from '../src/filters.js';

describe('parseRunFilters', () => {
  it('splits comma-separated multi-values', () => {
    const filters = parseRunFilters({ browser: 'chromium,firefox', locale: 'fr-FR' });
    expect(filters.browser).toEqual(['chromium', 'firefox']);
    expect(filters.locale).toEqual(['fr-FR']);
  });

  it('accepts repeated query params as arrays', () => {
    expect(parseRunFilters({ status: ['failed', 'errored'] }).status).toEqual([
      'errored',
      'failed',
    ]);
  });

  it('ignores unknown params so shareable links survive extra state', () => {
    const filters = parseRunFilters({ branch: 'main', tab: 'matrix', cursor: 'abc', page: '2' });
    expect(filters.branch).toEqual(['main']);
  });

  it('treats an empty value as absent', () => {
    expect(isEmptyFilters(parseRunFilters({ branch: '', q: '' }))).toBe(true);
  });

  it('rejects a status outside the domain vocabulary', () => {
    expect(() => parseRunFilters({ status: 'exploded' })).toThrow();
  });

  it('coerces dates', () => {
    const filters = parseRunFilters({ from: '2026-09-01T00:00:00.000Z' });
    expect(filters.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('serializeRunFilters', () => {
  it('round-trips', () => {
    const original = parseRunFilters({ browser: 'firefox,chromium', status: 'failed', q: 'cart' });
    const reparsed = parseRunFilters(Object.fromEntries(serializeRunFilters(original)));
    expect(reparsed).toEqual(original);
  });

  it('is stable: the same filter state always produces the same URL', () => {
    const a = serializeRunFilters(parseRunFilters({ browser: 'firefox,chromium', q: 'cart' }));
    const b = serializeRunFilters(parseRunFilters({ q: 'cart', browser: 'chromium,firefox' }));
    expect(a.toString()).toBe(b.toString());
  });

  it('omits absent filters entirely', () => {
    expect(serializeRunFilters(parseRunFilters({ branch: 'main' })).toString()).toBe('branch=main');
  });
});

describe('pagination', () => {
  it('defaults to a bounded page size', () => {
    expect(paginationSchema.parse({}).limit).toBe(50);
  });

  it('refuses an unbounded page', () => {
    expect(() => paginationSchema.parse({ limit: '10000' })).toThrow();
  });
});

describe('multi-value canonicalization', () => {
  it('deduplicates and sorts, because a multi-value filter is a set', () => {
    expect(parseRunFilters({ browser: 'firefox,chromium,firefox' }).browser).toEqual([
      'chromium',
      'firefox',
    ]);
  });
});
