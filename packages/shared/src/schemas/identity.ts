import { z } from 'zod';
import { orgRoleSchema, projectRoleSchema, themeSchema, uiLocaleSchema } from '../enums.js';
import { nameSchema, slugSchema, uuidSchema } from './common.js';

export const updateMeSchema = z
  .object({
    name: nameSchema.optional(),
    locale: uiLocaleSchema.optional(),
    theme: themeSchema.optional(),
  })
  .strict();

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const userSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string().email().nullable(),
  avatarUrl: z.string().url().nullable(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * `GET /v1/me` returns the whole authorization picture in one request: the
 * user, their orgs, and their role in every project they can see. The UI needs
 * all of it to decide what to render, and fetching it piecemeal would make the
 * first paint of every page depend on a waterfall.
 */
export const meSchema = z.object({
  user: userSummarySchema.extend({
    locale: uiLocaleSchema,
    theme: themeSchema,
  }),
  organizations: z.array(
    z.object({
      id: uuidSchema,
      slug: slugSchema,
      name: z.string(),
      role: orgRoleSchema,
    }),
  ),
  projects: z.array(
    z.object({
      id: uuidSchema,
      slug: slugSchema,
      name: z.string(),
      organizationId: uuidSchema,
      organizationSlug: slugSchema,
      role: projectRoleSchema,
    }),
  ),
});

export type Me = z.infer<typeof meSchema>;
