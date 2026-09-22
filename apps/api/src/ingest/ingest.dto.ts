import { z } from 'zod';
import { attachmentKindSchema, ingestEnvelopeSchema, runTriggerSchema } from '@eyesonbug/shared';

export const openRunSchema = z
  .object({
    branch: z.string().max(400).nullish(),
    commitSha: z.string().max(64).nullish(),
    commitMessage: z.string().max(2000).nullish(),
    commitAuthor: z.string().max(400).nullish(),
    buildVersion: z.string().max(200).nullish(),
    /** Matched by name against the project's environments; unknown names are ignored. */
    environment: z.string().max(200).nullish(),
    trigger: runTriggerSchema.default('api'),
    githubWorkflowRunId: z.number().int().nullish(),
    githubWorkflowName: z.string().max(400).nullish(),
    githubRunAttempt: z.number().int().nullish(),
  })
  .strict();

export type OpenRunInput = z.infer<typeof openRunSchema>;

export const presignAttachmentsSchema = z
  .object({
    attachments: z
      .array(
        z.object({
          resultRef: z.string().min(1).max(500),
          kind: attachmentKindSchema,
          contentType: z.string().min(1).max(256),
          sizeBytes: z
            .number()
            .int()
            .min(0)
            .max(500 * 1024 * 1024),
          sha256: z.string().length(64),
          name: z.string().max(400).optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type PresignAttachmentsInput = z.infer<typeof presignAttachmentsSchema>;

export { ingestEnvelopeSchema };
