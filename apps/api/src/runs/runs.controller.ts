import { Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { TenantDb, schema } from '@eyesonbug/db';
import { paginationSchema, parseRunFilters, type RunFilters } from '@eyesonbug/shared';
import { Access, AccessGuard, RequireCapability } from '../access/access.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { IngestService } from '../ingest/ingest.service';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { TENANT_DB } from '../database/database.module';
import { S3Service } from '../storage/s3.service';

/**
 * Reading runs.
 *
 * Every list is keyset-paginated on `(started_at, id)` rather than OFFSET:
 * a project accumulates runs indefinitely, and OFFSET makes page 500 scan
 * everything before it.
 */
@ApiTags('runs')
@Controller('v1/o/:org/p/:project')
@UseGuards(AccessGuard)
export class RunsController {
  constructor(
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
    private readonly s3: S3Service,
    private readonly ingest: IngestService,
  ) {}

  /**
   * Cancel a running run.
   *
   * Cooperative for now: it marks the run cancelled and the reporter stops
   * sending on its next flush. Stopping the GitHub Actions job itself needs the
   * GitHub App and arrives in M3.
   */
  @Post('runs/:runId/cancel')
  @RequireCapability('run:cancel')
  @ApiOperation({ summary: 'Cancel a run (cooperative until M3)' })
  cancel(
    @Access() access: AccessContext,
    @CurrentUser() user: SessionUser,
    @Param('runId') runId: string,
  ) {
    return this.ingest.cancel(access, runId, user.id);
  }

  @Get('runs')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Run history, newest first' })
  async list(
    @Access() access: AccessContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    const filters = parseRunFilters(query);
    const { cursor, limit } = paginationSchema.parse(query);

    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          id: schema.runs.id,
          number: schema.runs.number,
          status: schema.runs.status,
          trigger: schema.runs.trigger,
          branch: schema.runs.branch,
          commitSha: schema.runs.commitSha,
          commitMessage: schema.runs.commitMessage,
          buildVersion: schema.runs.buildVersion,
          startedAt: schema.runs.startedAt,
          finishedAt: schema.runs.finishedAt,
          durationMs: schema.runs.durationMs,
          totals: schema.runs.totals,
          environment: schema.environments.name,
        })
        .from(schema.runs)
        .leftJoin(schema.environments, eq(schema.environments.id, schema.runs.environmentId))
        .where(and(eq(schema.runs.projectId, access.projectId!), ...runConditions(filters, cursor)))
        .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
        .limit(limit + 1),
    );

    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      // The cursor encodes the sort key, so the next page continues from a
      // position rather than counting rows it has already read.
      nextCursor:
        rows.length > limit && last?.startedAt
          ? Buffer.from(`${last.startedAt.toISOString()}|${last.id}`).toString('base64url')
          : null,
    };
  }

  @Get('runs/:runId')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'One run, with its configurations' })
  async detail(@Access() access: AccessContext, @Param('runId') runId: string) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.runs.id,
          number: schema.runs.number,
          status: schema.runs.status,
          trigger: schema.runs.trigger,
          branch: schema.runs.branch,
          commitSha: schema.runs.commitSha,
          commitMessage: schema.runs.commitMessage,
          commitAuthor: schema.runs.commitAuthor,
          buildVersion: schema.runs.buildVersion,
          startedAt: schema.runs.startedAt,
          finishedAt: schema.runs.finishedAt,
          durationMs: schema.runs.durationMs,
          totals: schema.runs.totals,
          environment: schema.environments.name,
        })
        .from(schema.runs)
        .leftJoin(schema.environments, eq(schema.environments.id, schema.runs.environmentId))
        .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, access.projectId!)))
        .limit(1);

      const run = rows[0];
      if (!run) throw ApiError.notFound('Run');

      const configurations = await tx
        .select({
          id: schema.runConfigurations.id,
          status: schema.runConfigurations.status,
          browser: schema.configurations.browser,
          locale: schema.configurations.locale,
          os: schema.configurations.os,
          device: schema.configurations.device,
          dimensions: schema.configurations.dimensions,
        })
        .from(schema.runConfigurations)
        .innerJoin(
          schema.configurations,
          eq(schema.configurations.id, schema.runConfigurations.configurationId),
        )
        .where(eq(schema.runConfigurations.runId, runId));

      return { ...run, configurations };
    });
  }

  /**
   * Failures grouped by error signature.
   *
   * This is the shape the report opens with, because "12 tests failed with the
   * same timeout" is one thing to understand and one decision to make, whereas
   * twelve rows of red is twelve.
   */
  @Get('runs/:runId/failures')
  @RequireCapability('project:read')
  async failures(@Access() access: AccessContext, @Param('runId') runId: string) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const clusters = await tx
        .select({
          signatureId: schema.errorSignatures.id,
          errorType: schema.errorSignatures.errorType,
          normalizedMessage: schema.errorSignatures.normalizedMessage,
          count: sql<string>`count(*)::text`,
          affectedTests: sql<string>`count(distinct ${schema.testResults.testCaseId})::text`,
        })
        .from(schema.testResults)
        .innerJoin(
          schema.errorSignatures,
          eq(schema.errorSignatures.id, schema.testResults.errorSignatureId),
        )
        .where(
          and(
            eq(schema.testResults.runId, runId),
            eq(schema.testResults.isFinalAttempt, true),
            inArray(schema.testResults.status, ['failed', 'broken']),
          ),
        )
        .groupBy(
          schema.errorSignatures.id,
          schema.errorSignatures.errorType,
          schema.errorSignatures.normalizedMessage,
        )
        .orderBy(sql`count(*) desc`);

      const members = await tx
        .select({
          signatureId: schema.testResults.errorSignatureId,
          resultId: schema.testResults.id,
          title: schema.testCases.title,
          fullTitle: schema.testCases.fullTitle,
          filePath: schema.testCases.filePath,
          browser: schema.configurations.browser,
          locale: schema.configurations.locale,
        })
        .from(schema.testResults)
        .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testResults.testCaseId))
        .innerJoin(
          schema.runConfigurations,
          eq(schema.runConfigurations.id, schema.testResults.runConfigurationId),
        )
        .innerJoin(
          schema.configurations,
          eq(schema.configurations.id, schema.runConfigurations.configurationId),
        )
        .where(
          and(
            eq(schema.testResults.runId, runId),
            eq(schema.testResults.isFinalAttempt, true),
            inArray(schema.testResults.status, ['failed', 'broken']),
          ),
        );

      return clusters.map((cluster) => ({
        ...cluster,
        count: Number(cluster.count),
        affectedTests: Number(cluster.affectedTests),
        results: members.filter((member) => member.signatureId === cluster.signatureId),
      }));
    });
  }

  @Get('runs/:runId/results')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Results in a run, newest failures first' })
  async results(
    @Access() access: AccessContext,
    @Param('runId') runId: string,
    @Query('status') status?: string,
  ) {
    const wanted = status?.split(',').filter(Boolean) as
      Array<'passed' | 'failed' | 'skipped' | 'broken' | 'flaky'> | undefined;

    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({
          id: schema.testResults.id,
          status: schema.testResults.status,
          durationMs: schema.testResults.durationMs,
          retryIndex: schema.testResults.retryIndex,
          errorMessage: schema.testResults.errorMessage,
          testCaseId: schema.testCases.id,
          title: schema.testCases.title,
          fullTitle: schema.testCases.fullTitle,
          filePath: schema.testCases.filePath,
          feature: schema.features.key,
          browser: schema.configurations.browser,
          locale: schema.configurations.locale,
        })
        .from(schema.testResults)
        .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testResults.testCaseId))
        .leftJoin(schema.features, eq(schema.features.id, schema.testCases.featureId))
        .innerJoin(
          schema.runConfigurations,
          eq(schema.runConfigurations.id, schema.testResults.runConfigurationId),
        )
        .innerJoin(
          schema.configurations,
          eq(schema.configurations.id, schema.runConfigurations.configurationId),
        )
        .where(
          and(
            eq(schema.testResults.runId, runId),
            eq(schema.testResults.isFinalAttempt, true),
            // A row still executing is live-view state, not a report row.
            sql`${schema.testResults.status} <> 'running'`,
            ...(wanted && wanted.length > 0 ? [inArray(schema.testResults.status, wanted)] : []),
          ),
        )
        // Failures first: the reason anyone opened this page.
        .orderBy(
          sql`case ${schema.testResults.status}
                when 'failed' then 0 when 'broken' then 1 when 'flaky' then 2
                when 'passed' then 3 else 4 end`,
          schema.testCases.fullTitle,
        )
        .limit(2000),
    );
  }

  @Get('results/:resultId')
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'One result: error, steps, attachments, retries' })
  async result(@Access() access: AccessContext, @Param('resultId') resultId: string) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.testResults.id,
          status: schema.testResults.status,
          durationMs: schema.testResults.durationMs,
          retryIndex: schema.testResults.retryIndex,
          startedAt: schema.testResults.startedAt,
          errorType: schema.testResults.errorType,
          errorMessage: schema.testResults.errorMessage,
          stackTrace: schema.testResults.stackTrace,
          testCaseId: schema.testCases.id,
          title: schema.testCases.title,
          fullTitle: schema.testCases.fullTitle,
          filePath: schema.testCases.filePath,
          browser: schema.configurations.browser,
          locale: schema.configurations.locale,
        })
        .from(schema.testResults)
        .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testResults.testCaseId))
        .innerJoin(
          schema.runConfigurations,
          eq(schema.runConfigurations.id, schema.testResults.runConfigurationId),
        )
        .innerJoin(
          schema.configurations,
          eq(schema.configurations.id, schema.runConfigurations.configurationId),
        )
        .where(eq(schema.testResults.id, resultId))
        .limit(1);

      const result = rows[0];
      if (!result) throw ApiError.notFound('Result');

      const attachments = await tx
        .select({
          id: schema.attachments.id,
          kind: schema.attachments.kind,
          contentType: schema.attachments.contentType,
          sizeBytes: schema.attachments.sizeBytes,
        })
        .from(schema.attachments)
        .where(eq(schema.attachments.testResultId, resultId));

      // Last 30 outcomes of this test, so "is this new?" is answerable without
      // leaving the drawer.
      const history = await tx
        .select({
          id: schema.testResults.id,
          status: schema.testResults.status,
          startedAt: schema.testResults.startedAt,
          runNumber: schema.runs.number,
        })
        .from(schema.testResults)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.testResults.runId))
        .where(
          and(
            eq(schema.testResults.testCaseId, result.testCaseId),
            eq(schema.testResults.isFinalAttempt, true),
            sql`${schema.testResults.status} <> 'running'`,
          ),
        )
        .orderBy(desc(schema.testResults.startedAt))
        .limit(30);

      return { ...result, attachments, history };
    });
  }

  /**
   * Artifacts are never streamed through the API. Authorization happens here,
   * then the browser is redirected to a short-lived signed URL.
   */
  @Get('attachments/:attachmentId')
  @RequireCapability('project:read')
  async attachment(
    @Access() access: AccessContext,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select({ s3Key: schema.attachments.s3Key, kind: schema.attachments.kind })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.id, attachmentId),
            eq(schema.attachments.projectId, access.projectId!),
          ),
        )
        .limit(1),
    );

    const attachment = rows[0];
    if (!attachment) throw ApiError.notFound('Attachment');

    const url = await this.s3.presignDownload(attachment.s3Key);
    void reply.redirect(url, 302);
  }
}

function runConditions(filters: RunFilters, cursor?: string) {
  const conditions = [];

  if (filters.branch) conditions.push(inArray(schema.runs.branch, filters.branch));
  if (filters.status) conditions.push(inArray(schema.runs.status, filters.status));
  if (filters.trigger) conditions.push(inArray(schema.runs.trigger, filters.trigger));
  if (filters.commit) conditions.push(eq(schema.runs.commitSha, filters.commit));
  if (filters.build) conditions.push(eq(schema.runs.buildVersion, filters.build));
  if (filters.from) conditions.push(sql`${schema.runs.startedAt} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${schema.runs.startedAt} <= ${filters.to}`);

  if (cursor) {
    const [startedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (startedAt && id) {
      conditions.push(
        sql`(${schema.runs.startedAt}, ${schema.runs.id}) < (${new Date(startedAt)}, ${id}::uuid)`,
      );
    }
  }

  return conditions;
}
