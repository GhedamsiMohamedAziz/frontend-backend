import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { verifyWebhookSignature } from '@eyesonbug/shared/node';
import { Public } from '../auth/auth.guard';
import { ApiError } from '../common/errors';
import type { AppRequest } from '../common/request-context';
import { env } from '../config/env';
import { QueueService } from '../queue/queue.service';

/** Events the worker knows how to fold into our tables. Others are acknowledged and dropped. */
const HANDLED_EVENTS = new Set(['installation', 'installation_repositories', 'workflow_run']);

/**
 * GitHub → EyesOnBug. Verified with the App's webhook secret over the *raw*
 * body (a re-serialized JSON would not match), then queued: GitHub expects an
 * answer within seconds and retries are manual, so nothing slow runs here.
 */
@ApiTags('github')
@Controller('v1/webhooks/github')
@Public()
export class GitHubWebhooksController {
  constructor(private readonly queue: QueueService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'GitHub App webhook receiver' })
  async receive(
    @Req() request: AppRequest & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
  ): Promise<{ queued: boolean }> {
    const secret = env().GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      throw new ApiError(
        'github_not_configured',
        'GITHUB_WEBHOOK_SECRET is not set',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!request.rawBody || !verifyWebhookSignature(secret, request.rawBody, signature)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    if (!event || !deliveryId) throw ApiError.badRequest('Missing GitHub webhook headers');

    if (!HANDLED_EVENTS.has(event)) return { queued: false };
    await this.queue.enqueueGithubEvent({ event, deliveryId, payload: request.body });
    return { queued: true };
  }
}
