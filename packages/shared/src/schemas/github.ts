import { z } from 'zod';
import { nameSchema } from './common.js';

/**
 * One `workflow_dispatch` input, as declared in the workflow file. Parsed from
 * the YAML by the API and stored on `workflow_config.inputs_schema`, so the
 * launcher form is generated from the workflow rather than hand-maintained.
 */
export const workflowInputSchema = z.object({
  type: z.enum(['string', 'boolean', 'choice', 'number', 'environment']).default('string'),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  options: z.array(z.string()).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowInputsSchema = z.record(z.string(), workflowInputSchema);
export type WorkflowInputs = z.infer<typeof workflowInputsSchema>;

/**
 * Values sent to GitHub. GitHub accepts strings only (booleans and numbers are
 * sent as their string form) and at most 25 properties — verified against the
 * REST docs for `POST .../workflows/{id}/dispatches`, 2026-09-22.
 */
export const DISPATCH_INPUT_LIMIT = 25;
export const dispatchInputsSchema = z
  .record(z.string().min(1).max(100), z.string().max(65_535))
  .refine((inputs) => Object.keys(inputs).length <= DISPATCH_INPUT_LIMIT, {
    message: `GitHub accepts at most ${DISPATCH_INPUT_LIMIT} inputs`,
  });
export type DispatchInputs = z.infer<typeof dispatchInputsSchema>;

const repoFullNameSchema = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'Expected owner/repo');

/** Workflow files live under .github/workflows; GitHub identifies them by basename. */
export const workflowFileSchema = z
  .string()
  .trim()
  .regex(/^[\w.-]+\.ya?ml$/, 'Expected a workflow file name such as e2e.yml');

export const createWorkflowConfigSchema = z
  .object({
    name: nameSchema,
    repoFullName: repoFullNameSchema,
    workflowFile: workflowFileSchema,
    ref: z.string().trim().min(1).max(200).default('main'),
    defaultInputs: dispatchInputsSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateWorkflowConfigInput = z.infer<typeof createWorkflowConfigSchema>;

export const updateWorkflowConfigSchema = createWorkflowConfigSchema.partial().strict();
export type UpdateWorkflowConfigInput = z.infer<typeof updateWorkflowConfigSchema>;

export const dispatchWorkflowSchema = z
  .object({
    ref: z.string().trim().min(1).max(200).optional(),
    inputs: dispatchInputsSchema.default({}),
  })
  .strict();
export type DispatchWorkflowInput = z.infer<typeof dispatchWorkflowSchema>;

export const linkInstallationSchema = z
  .object({ installationId: z.number().int().positive() })
  .strict();
export type LinkInstallationInput = z.infer<typeof linkInstallationSchema>;

/**
 * Merge the caller's inputs over the config defaults and check them against
 * the workflow's declared inputs, so GitHub's 422 is never the first thing a
 * user sees. Booleans and numbers are sent as strings, as GitHub expects.
 */
export function resolveDispatchInputs(
  declared: WorkflowInputs,
  defaults: Record<string, string>,
  given: Record<string, string>,
): { inputs: Record<string, string>; errors: string[] } {
  const merged: Record<string, string> = { ...defaults, ...given };
  const errors: string[] = [];
  const inputs: Record<string, string> = {};

  for (const name of Object.keys(merged)) {
    if (!(name in declared)) errors.push(`"${name}" is not an input of this workflow`);
  }
  for (const [name, spec] of Object.entries(declared)) {
    const value = merged[name] ?? (spec.default !== undefined ? String(spec.default) : undefined);
    if (value === undefined) {
      if (spec.required) errors.push(`"${name}" is required`);
      continue;
    }
    if (spec.type === 'choice' && spec.options && !spec.options.includes(value)) {
      errors.push(`"${name}" must be one of ${spec.options.join(', ')}`);
    }
    if (spec.type === 'boolean' && value !== 'true' && value !== 'false') {
      errors.push(`"${name}" must be true or false`);
    }
    if (spec.type === 'number' && Number.isNaN(Number(value))) {
      errors.push(`"${name}" must be a number`);
    }
    inputs[name] = value;
  }
  if (Object.keys(inputs).length > DISPATCH_INPUT_LIMIT) {
    errors.push(`GitHub accepts at most ${DISPATCH_INPUT_LIMIT} inputs`);
  }
  return { inputs, errors };
}
