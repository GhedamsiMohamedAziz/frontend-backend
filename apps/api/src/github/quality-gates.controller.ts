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
  type CreateQualityGateInput,
  type UpdateQualityGateInput,
  createQualityGateSchema,
  updateQualityGateSchema,
} from '@eyesonbug/shared';
import { Access, AccessGuard, RequireCapability } from '../access/access.guard';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { TENANT_DB } from '../database/database.module';

/**
 * A quality gate is a statement about a sealed run (ADR-006): evaluated by
 * the worker when the run finishes and reported to GitHub as a check run on
 * the commit, so it can be required by branch protection.
 */
@ApiTags('quality-gates')
@Controller('v1/o/:org/p/:project/quality-gates')
@UseGuards(AccessGuard)
export class QualityGatesController {
  constructor(@Inject(TENANT_DB) private readonly tenant: TenantDb) {}

  @Get()
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Quality gates for this project' })
  list(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.qualityGates)
        .where(eq(schema.qualityGates.projectId, access.projectId!))
        .orderBy(schema.qualityGates.name),
    );
  }

  @Post()
  @RequireCapability('gate:manage')
  @ApiOperation({ summary: 'Create a quality gate' })
  async create(
    @Access() access: AccessContext,
    @Body(zodPipe(createQualityGateSchema)) body: CreateQualityGateInput,
  ) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const [row] = await tx
        .insert(schema.qualityGates)
        .values({ organizationId: access.organizationId, projectId: access.projectId!, ...body })
        .onConflictDoNothing()
        .returning();
      if (!row) throw ApiError.conflict(`A gate named "${body.name}" already exists`);
      return row;
    });
  }

  @Patch(':id')
  @RequireCapability('gate:manage')
  @ApiOperation({ summary: 'Update a quality gate' })
  async update(
    @Access() access: AccessContext,
    @Param('id') id: string,
    @Body(zodPipe(updateQualityGateSchema)) body: UpdateQualityGateInput,
  ) {
    await this.load(access, id);
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const [row] = await tx
        .update(schema.qualityGates)
        .set(body)
        .where(eq(schema.qualityGates.id, id))
        .returning();
      return row;
    });
  }

  @Delete(':id')
  @RequireCapability('gate:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a quality gate' })
  async remove(@Access() access: AccessContext, @Param('id') id: string): Promise<void> {
    await this.load(access, id);
    await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx.delete(schema.qualityGates).where(eq(schema.qualityGates.id, id)),
    );
  }

  private async load(access: AccessContext, id: string) {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({ id: schema.qualityGates.id })
        .from(schema.qualityGates)
        .where(
          and(eq(schema.qualityGates.id, id), eq(schema.qualityGates.projectId, access.projectId!)),
        )
        .limit(1),
    );
    if (!rows[0]) throw ApiError.notFound('Quality gate');
    return rows[0];
  }
}
