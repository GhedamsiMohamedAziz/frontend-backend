import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { QueueService } from '../queue/queue.service';
import { S3Service } from '../storage/s3.service';
import { ApiTokenGuard } from './api-token.guard';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [RealtimeModule],
  controllers: [IngestController],
  providers: [IngestService, ApiTokenGuard, S3Service, QueueService],
  exports: [S3Service, QueueService, IngestService],
})
export class IngestModule {}
