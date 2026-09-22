import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/**
 * Slugs appear in every URL (`/o/:org/p/:project/...`), so they are restricted
 * to what is safe and readable in a path segment and stable when copied.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes');

export const nameSchema = z.string().trim().min(1).max(200);

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Every API error has this shape, so the client renders failures uniformly. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
