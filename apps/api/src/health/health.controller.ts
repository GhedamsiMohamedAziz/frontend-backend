import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { SystemDb } from '@eyesonbug/db';
import { Public } from '../auth/auth.guard';
import { SYSTEM_DB } from '../database/database.module';

@ApiTags('ops')
@Controller()
export class HealthController {
  constructor(@Inject(SYSTEM_DB) private readonly system: SystemDb) {}

  /**
   * Liveness: is the process up? Deliberately does not touch the database —
   * a liveness probe that fails during a brief database blip would have the
   * orchestrator restart healthy pods and turn a small outage into a big one.
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /** Readiness: can this instance actually serve traffic right now? */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready(): Promise<{ status: 'ready' | 'degraded'; checks: Record<string, boolean> }> {
    const checks: Record<string, boolean> = { database: false };
    try {
      await this.system.db.execute(sql`select 1`);
      checks.database = true;
    } catch {
      checks.database = false;
    }
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? 'ready' : 'degraded', checks };
  }
}
