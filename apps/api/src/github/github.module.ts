import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';
import { GitHubWebhooksController } from './webhooks.controller';
import { WorkflowConfigsController } from './workflow-configs.controller';
import { SchedulesController } from './schedules.controller';
import { QualityGatesController } from './quality-gates.controller';

@Module({
  imports: [IngestModule],
  controllers: [
    GitHubController,
    GitHubWebhooksController,
    WorkflowConfigsController,
    SchedulesController,
    QualityGatesController,
  ],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
