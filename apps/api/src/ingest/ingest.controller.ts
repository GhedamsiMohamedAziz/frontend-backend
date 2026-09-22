import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { IngestEnvelope } from '@eyesonbug/shared';
import { Access } from '../access/access.guard';
import { Public } from '../auth/auth.guard';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { ApiTokenGuard } from './api-token.guard';
import { ingestEnvelopeSchema, openRunSchema, presignAttachmentsSchema } from './ingest.dto';
import type { OpenRunInput, PresignAttachmentsInput } from './ingest.dto';
import { IngestService } from './ingest.service';

/**
 * The CI-facing surface.
 *
 * `@Public()` opts out of the session guard — these routes are not reached by a
 * browser with a cookie — and `ApiTokenGuard` replaces it with bearer-token
 * authentication. The token is bound to one project, so it carries its own
 * tenant context and there is nothing in the path to scope.
 */
@ApiTags('ingest')
@Controller('v1/ingest')
@Public()
@UseGuards(ApiTokenGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('runs')
  @ApiOperation({ summary: 'Open a run (idempotent on Idempotency-Key)' })
  async openRun(
    @Access() access: AccessContext,
    @Body(zodPipe(openRunSchema)) body: OpenRunInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      // Without a key a retried CI job silently creates a second run, and the
      // history quietly fills with phantom duplicates. Better to refuse.
      throw ApiError.badRequest('An Idempotency-Key header is required to open a run');
    }
    return this.ingest.openRun(access, body, idempotencyKey, undefined);
  }

  @Post('runs/:runId/attachments')
  @ApiOperation({ summary: 'Get presigned upload URLs for artifacts' })
  presign(
    @Access() access: AccessContext,
    @Param('runId') runId: string,
    @Body(zodPipe(presignAttachmentsSchema)) body: PresignAttachmentsInput,
  ) {
    return this.ingest.presignAttachments(access, runId, body);
  }

  @Post('runs/:runId/events')
  @ApiOperation({ summary: 'Submit a batch of result events' })
  events(
    @Access() access: AccessContext,
    @Param('runId') runId: string,
    @Body(zodPipe(ingestEnvelopeSchema)) body: IngestEnvelope,
  ) {
    return this.ingest.acceptEvents(access, runId, body.events);
  }

  @Post('runs/:runId/complete')
  @ApiOperation({ summary: 'Seal the run and queue it for processing' })
  complete(@Access() access: AccessContext, @Param('runId') runId: string) {
    return this.ingest.complete(access, runId);
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Run status, so CI can wait for processing' })
  status(@Access() access: AccessContext, @Param('runId') runId: string) {
    return this.ingest.status(access, runId);
  }
}
