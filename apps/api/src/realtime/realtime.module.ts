import { Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { RealtimeService } from './realtime.service';

@Module({
  controllers: [LiveController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
