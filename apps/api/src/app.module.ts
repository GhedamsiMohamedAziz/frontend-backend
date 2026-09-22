import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessModule } from './access/access.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { OrganizationsController } from './organizations/organizations.controller';
import { ProjectsController } from './projects/projects.controller';
import { RealtimeModule } from './realtime/realtime.module';
import { RunsController } from './runs/runs.controller';
import { MeController } from './users/me.controller';

@Module({
  imports: [DatabaseModule, AuthModule, AccessModule, IngestModule, RealtimeModule],
  controllers: [
    HealthController,
    MeController,
    OrganizationsController,
    ProjectsController,
    RunsController,
  ],
  providers: [
    // Authentication is global and opted *out* of with @Public(), so a new
    // endpoint is private unless someone deliberately says otherwise.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
