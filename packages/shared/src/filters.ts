import { z } from 'zod';
import { runStatusSchema, runTriggerSchema } from './enums.js';

/**
 * One filter vocabulary, parsed by one parser, used by the URL bar, the API,
 * the CSV export and every saved view.
 *
 * The spec requires that History, Report and Metrics share a filter bar and
 * that every filter state is a shareable link. Both fall out of having a single
 * definition: if a pasted URL, an API call and an export can disagree about
 * what `?locale=fr-FR&status=failed` means, the links are not really shareable.
 */

/**
 * Comma-separated in the URL (`?browser=chromium,firefox`), array in code.
 *
 * Values are deduplicated and sorted at parse time. A multi-value filter is a
 * set, so order carries no meaning — canonicalizing on the way *in* is what
 * makes "the same filter state always produces the same URL" true no matter
 * which side constructed it, and makes parse/serialize a true round trip.
 */
const multi = z
  .union([z.string(), z.array(z.string())])
  .transform((value): string[] => {
    const parts = (Array.isArray(value) ? value : value.split(','))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return [...new Set(parts)].sort();
  })
  .pipe(z.array(z.string()).min(1));

const multiOf = <T extends z.ZodTypeAny>(inner: T) => multi.pipe(z.array(inner));

export const runFiltersSchema = z
  .object({
    branch: multi.optional(),
    commit: z.string().trim().min(7).max(40).optional(),
    build: z.string().trim().min(1).max(200).optional(),
    environment: multi.optional(),
    status: multiOf(runStatusSchema).optional(),
    trigger: multiOf(runTriggerSchema).optional(),
    feature: multi.optional(),
    tag: multi.optional(),
    owner: multi.optional(),
    // Configuration dimensions. `locale` here is the locale the tests ran
    // under, never the language of the EyesOnBug interface.
    browser: multi.optional(),
    device: multi.optional(),
    os: multi.optional(),
    locale: multi.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type RunFilters = z.infer<typeof runFiltersSchema>;

/** Declared order, so the same filter state always serializes to the same URL. */
export const FILTER_KEYS = [
  'q',
  'branch',
  'commit',
  'build',
  'environment',
  'status',
  'trigger',
  'feature',
  'tag',
  'owner',
  'browser',
  'device',
  'os',
  'locale',
  'from',
  'to',
] as const satisfies readonly (keyof RunFilters)[];

export type RawQuery = Record<string, string | string[] | undefined>;

/**
 * Parse a query object into filters. Unknown keys are dropped rather than
 * rejected: a link may legitimately carry pagination, tab or anchor params,
 * and failing the whole request over them would break shareable URLs.
 */
export function parseRunFilters(query: RawQuery): RunFilters {
  const known: RawQuery = {};
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (value !== undefined && value !== '') known[key] = value;
  }
  return runFiltersSchema.parse(known);
}

/** Inverse of `parseRunFilters`. Stable key order, stable array order. */
export function serializeRunFilters(filters: RunFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Already canonical (deduped and sorted) from `multi`.
      if (value.length > 0) params.set(key, value.join(','));
    } else if (value instanceof Date) {
      params.set(key, value.toISOString());
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

export function isEmptyFilters(filters: RunFilters): boolean {
  return FILTER_KEYS.every((key) => filters[key] === undefined);
}

/** Keyset pagination. OFFSET degrades badly past a few thousand rows. */
export const paginationSchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
