import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';
import { GitHubWebhooksController } from './webhooks.controller';
import { WorkflowConfigsController } from './workflow-configs.controller';

@Module({
  imports: [IngestModule],
  controllers: [GitHubController, GitHubWebhooksController, WorkflowConfigsController],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
