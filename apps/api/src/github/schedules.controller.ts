import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { TenantDb, schema } from '@eyesonbug/db';
import {
  type CreateScheduleInput,
  type UpdateScheduleInput,
  createScheduleSchema,
  updateScheduleSchema,
} from '@eyesonbug/shared';
import { nextCronRun } from '@eyesonbug/shared/node';
import { Access, AccessGuard, RequireCapability } from '../access/access.guard';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { TENANT_DB } from '../database/database.module';

/**
 * Schedules launch a run template on a cron. The worker ticks once a minute
 * and dispatches whatever is due (ADR-025); `next_run_at` is kept here so a
 * schedule that is created, edited or disabled takes effect on the next tick
 * with nothing to sync elsewhere.
 */
@ApiTags('schedules')
@Controller('v1/o/:org/p/:project/schedules')
@UseGuards(AccessGuard)
export class SchedulesController {
  constructor(@Inject(TENANT_DB) private readonly tenant: TenantDb) {}

  @Get()
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Schedules for this project' })
  list(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.projectId, access.projectId!))
        .orderBy(schema.schedules.name),
    );
  }

  @Post()
  @RequireCapability('schedule:manage')
  @ApiOperation({ summary: 'Create a schedule' })
  async create(
    @Access() access: AccessContext,
    @Body(zodPipe(createScheduleSchema)) body: CreateScheduleInput,
  ) {
    const nextRunAt = this.nextRun(body.cron, body.timezone);
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const config = await tx
        .select({ id: schema.workflowConfigs.id })
        .from(schema.workflowConfigs)
        .where(
          and(
            eq(schema.workflowConfigs.id, body.workflowConfigId),
            eq(schema.workflowConfigs.projectId, access.projectId!),
          ),
        )
        .limit(1);
      if (!config[0]) throw ApiError.notFound('Workflow template');

      const [row] = await tx
        .insert(schema.schedules)
        .values({
          organizationId: access.organizationId,
          projectId: access.projectId!,
          ...body,
          nextRunAt: body.enabled ? nextRunAt : null,
        })
        .returning();
      return row;
    });
  }

  @Patch(':id')
  @RequireCapability('schedule:manage')
  @ApiOperation({ summary: 'Update a schedule' })
  async update(
    @Access() access: AccessContext,
    @Param('id') id: string,
    @Body(zodPipe(updateScheduleSchema)) body: UpdateScheduleInput,
  ) {
    const current = await this.load(access, id);
    const cron = body.cron ?? current.cron;
    const timezone = body.timezone ?? current.timezone;
    const enabled = body.enabled ?? current.enabled;
    const nextRunAt = enabled ? this.nextRun(cron, timezone) : null;

    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const [row] = await tx
        .update(schema.schedules)
        .set({ ...body, nextRunAt })
        .where(eq(schema.schedules.id, id))
        .returning();
      return row;
    });
  }

  @Delete(':id')
  @RequireCapability('schedule:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a schedule' })
  async remove(@Access() access: AccessContext, @Param('id') id: string): Promise<void> {
    await this.load(access, id);
    await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx.delete(schema.schedules).where(eq(schema.schedules.id, id)),
    );
  }

  private nextRun(cron: string, timezone: string): Date {
    try {
      return nextCronRun(cron, timezone);
    } catch (error) {
      throw ApiError.badRequest(`Invalid schedule: ${(error as Error).message}`);
    }
  }

  private async load(access: AccessContext, id: string) {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.schedules)
        .where(and(eq(schema.schedules.id, id), eq(schema.schedules.projectId, access.projectId!)))
        .limit(1),
    );
    if (!rows[0]) throw ApiError.notFound('Schedule');
    return rows[0];
  }
}
