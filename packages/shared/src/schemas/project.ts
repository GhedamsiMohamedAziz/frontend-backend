import { z } from 'zod';
import { projectRoleSchema, statsWindowSchema } from '../enums.js';
import { nameSchema, slugSchema, uuidSchema } from './common.js';

export const createProjectSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    repoFullName: z
      .string()
      .trim()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'Expected owner/repo')
      .optional(),
    defaultBranch: z.string().trim().min(1).max(200).default('main'),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const projectSettingsSchema = z
  .object({
    /** ADR-007: the rolling window used for the flakiness score. */
    flakinessWindow: statsWindowSchema.default('14d'),
    flakinessSampleSize: z.number().int().min(10).max(500).default(50),
    /** Quarantined tests still run; they just cannot fail the quality gate. */
    quarantineBlocksGate: z.boolean().default(false),
  })
  .strict();
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    repoFullName: z.string().trim().nullable().optional(),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    settings: projectSettingsSchema.partial().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const setProjectRoleSchema = z
  .object({ userId: uuidSchema, role: projectRoleSchema })
  .strict();
export type SetProjectRoleInput = z.infer<typeof setProjectRoleSchema>;

export const createEnvironmentSchema = z
  .object({
    name: nameSchema,
    baseUrl: z.string().url().nullable().optional(),
    isProduction: z.boolean().default(false),
  })
  .strict();
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;

export const createApiTokenSchema = z
  .object({
    name: nameSchema,
    scopes: z
      .array(z.enum(['ingest:write', 'runs:read']))
      .min(1)
      .default(['ingest:write']),
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict();
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

export const projectSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  repoFullName: z.string().nullable(),
  defaultBranch: z.string(),
  settings: projectSettingsSchema,
  createdAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Project = z.infer<typeof projectSchema>;
