import { z } from 'zod';
import { orgRoleSchema } from '../enums.js';
import { nameSchema, slugSchema, uuidSchema } from './common.js';

export const createOrganizationSchema = z
  .object({ name: nameSchema, slug: slugSchema.optional() })
  .strict();
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({ name: nameSchema.optional() }).strict();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z
  .object({ githubLogin: z.string().trim().min(1).max(100), role: orgRoleSchema })
  .strict();
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({ role: orgRoleSchema }).strict();
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const createTeamSchema = z
  .object({ name: nameSchema, slug: slugSchema.optional() })
  .strict();
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const organizationSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  createdAt: z.coerce.date(),
});
export type Organization = z.infer<typeof organizationSchema>;
