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
  // A template default the workflow no longer declares is dropped silently:
  // it is stale configuration, not a caller mistake. A caller's unknown key
  // is an error, since GitHub would refuse it.
  const errors: string[] = [];
  const inputs: Record<string, string> = {};
  for (const name of Object.keys(given)) {
    if (!(name in declared)) errors.push(`"${name}" is not an input of this workflow`);
  }
  const merged: Record<string, string> = { ...defaults, ...given };
  for (const [name, spec] of Object.entries(declared)) {
    // An empty string means "not provided": fall back to the default.
    const provided = merged[name]?.trim() ? merged[name] : undefined;
    const value = provided ?? (spec.default !== undefined ? String(spec.default) : undefined);
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
    if (spec.type === 'number' && (!value.trim() || Number.isNaN(Number(value)))) {
      errors.push(`"${name}" must be a number`);
    }
    inputs[name] = value;
  }
  if (Object.keys(inputs).length > DISPATCH_INPUT_LIMIT) {
    errors.push(`GitHub accepts at most ${DISPATCH_INPUT_LIMIT} inputs`);
  }
  return { inputs, errors };
}

// ─── Schedules ──────────────────────────────────────────────────────────────

export const createScheduleSchema = z
  .object({
    name: nameSchema,
    workflowConfigId: z.string().uuid(),
    /** Five-field cron, validated with cron-parser by the API. */
    cron: z.string().trim().min(9).max(100),
    /** IANA zone, so "02:00 Europe/Paris" survives DST. */
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    inputs: dispatchInputsSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = createScheduleSchema.partial().strict();
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

// ─── Quality gates ──────────────────────────────────────────────────────────

/**
 * M3 rules are computable from one run's totals. Rules that need history
 * (`allowNewFailures`, flakiness-aware) arrive with the M4 stats (ADR-010).
 */
export const gateRulesSchema = z
  .object({
    /** Pass rate over non-skipped results; flaky counts as passed. */
    minPassRate: z.number().min(0).max(1).optional(),
    /** Failed + broken results allowed, after quarantine is applied. */
    maxFailed: z.number().int().min(0).optional(),
  })
  .strict();
export type GateRules = z.infer<typeof gateRulesSchema>;

export const createQualityGateSchema = z
  .object({
    name: nameSchema,
    rules: gateRulesSchema.default({}),
    /** Exact branch names, or `*` for every branch. */
    appliesToBranches: z.array(z.string().trim().min(1).max(200)).min(1).default(['main']),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateQualityGateInput = z.infer<typeof createQualityGateSchema>;

export const updateQualityGateSchema = createQualityGateSchema.partial().strict();
export type UpdateQualityGateInput = z.infer<typeof updateQualityGateSchema>;

export interface GateTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  broken: number;
  flaky: number;
}

/** piggy: exact names or `*`; add glob matching when someone asks for release/*. */
export function branchMatches(patterns: readonly string[], branch: string | null): boolean {
  return patterns.includes('*') || (branch !== null && patterns.includes(branch));
}

/**
 * Evaluate a gate against sealed totals. `quarantinedFailures` are failed or
 * broken results whose test was quarantined at the time; they are forgiven
 * unless the project says quarantine still blocks the gate.
 */
export function evaluateGateRules(
  rules: GateRules,
  totals: GateTotals,
  quarantinedFailures: number,
  runErrored: boolean,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (runErrored) reasons.push('the run did not finish');

  const failures = Math.max(0, totals.failed + totals.broken - quarantinedFailures);
  if (rules.maxFailed !== undefined && failures > rules.maxFailed) {
    reasons.push(`${failures} failed, at most ${rules.maxFailed} allowed`);
  }

  const considered = totals.total - totals.skipped;
  if (rules.minPassRate !== undefined && considered > 0) {
    const rate = (totals.passed + totals.flaky + quarantinedFailures) / considered;
    if (rate < rules.minPassRate) {
      reasons.push(
        `pass rate ${(rate * 100).toFixed(1)}% is below ${(rules.minPassRate * 100).toFixed(1)}%`,
      );
    }
  }
  return { passed: reasons.length === 0, reasons };
}
