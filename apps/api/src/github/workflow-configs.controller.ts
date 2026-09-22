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
import { parse as parseYaml } from 'yaml';
import { TenantDb, createDispatchedRun, schema } from '@eyesonbug/db';
import {
  type CreateWorkflowConfigInput,
  type DispatchWorkflowInput,
  type UpdateWorkflowConfigInput,
  type WorkflowInputs,
  createWorkflowConfigSchema,
  dispatchWorkflowSchema,
  resolveDispatchInputs,
  updateWorkflowConfigSchema,
} from '@eyesonbug/shared';
import { extractDispatchInputs, GitHubApiError } from '@eyesonbug/shared/node';
import { Access, AccessGuard, RequireCapability } from '../access/access.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ApiError } from '../common/errors';
import type { AccessContext } from '../common/request-context';
import { zodPipe } from '../common/zod-validation.pipe';
import { TENANT_DB } from '../database/database.module';
import { GitHubService, type InstallationRow } from './github.service';

/**
 * Run templates: a workflow in a repository the org's installation can reach,
 * a ref, and defaults for its `workflow_dispatch` inputs. The inputs schema is
 * read from the workflow file when the config is created or its target
 * changes, so the launcher form cannot drift from the workflow it triggers.
 */
@ApiTags('workflows')
@Controller('v1/o/:org/p/:project/workflow-configs')
@UseGuards(AccessGuard)
export class WorkflowConfigsController {
  constructor(
    private readonly github: GitHubService,
    @Inject(TENANT_DB) private readonly tenant: TenantDb,
  ) {}

  @Get()
  @RequireCapability('project:read')
  @ApiOperation({ summary: 'Run templates for this project' })
  list(@Access() access: AccessContext) {
    return this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.workflowConfigs)
        .where(eq(schema.workflowConfigs.projectId, access.projectId!))
        .orderBy(schema.workflowConfigs.name),
    );
  }

  @Post()
  @RequireCapability('workflow:manage')
  @ApiOperation({ summary: 'Create a run template from a workflow file' })
  async create(
    @Access() access: AccessContext,
    @Body(zodPipe(createWorkflowConfigSchema)) body: CreateWorkflowConfigInput,
  ) {
    const installation = await this.github.requireInstallation(access.organizationId);
    const inputsSchema = await this.readInputs(
      installation,
      body.repoFullName,
      body.workflowFile,
      body.ref,
    );

    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const [row] = await tx
        .insert(schema.workflowConfigs)
        .values({
          organizationId: access.organizationId,
          projectId: access.projectId!,
          ...body,
          inputsSchema,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw ApiError.conflict(`A template named "${body.name}" already exists`);
      return row;
    });
  }

  @Patch(':id')
  @RequireCapability('workflow:manage')
  @ApiOperation({ summary: 'Update a run template' })
  async update(
    @Access() access: AccessContext,
    @Param('id') id: string,
    @Body(zodPipe(updateWorkflowConfigSchema)) body: UpdateWorkflowConfigInput,
  ) {
    const current = await this.load(access, id);
    const target = {
      repoFullName: body.repoFullName ?? current.repoFullName,
      workflowFile: body.workflowFile ?? current.workflowFile,
      ref: body.ref ?? current.ref,
    };
    const retargeted =
      target.repoFullName !== current.repoFullName ||
      target.workflowFile !== current.workflowFile ||
      target.ref !== current.ref;
    const inputsSchema = retargeted
      ? await this.readInputs(
          await this.github.requireInstallation(access.organizationId),
          target.repoFullName,
          target.workflowFile,
          target.ref,
        )
      : current.inputsSchema;

    return this.tenant.withOrg({ organizationId: access.organizationId }, async (tx) => {
      const [row] = await tx
        .update(schema.workflowConfigs)
        .set({ ...body, inputsSchema, updatedAt: new Date() })
        .where(eq(schema.workflowConfigs.id, id))
        .returning();
      return row;
    });
  }

  @Delete(':id')
  @RequireCapability('workflow:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a run template (its schedules go with it)' })
  async remove(@Access() access: AccessContext, @Param('id') id: string): Promise<void> {
    await this.load(access, id);
    await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx.delete(schema.workflowConfigs).where(eq(schema.workflowConfigs.id, id)),
    );
  }

  /**
   * Launch the workflow. GitHub answers with the new workflow run's id, so
   * the Run row exists before this returns and the UI can go straight to it;
   * the reporter inside the job joins the same row by that id.
   */
  @Post(':id/dispatch')
  @RequireCapability('run:trigger')
  @ApiOperation({ summary: 'Trigger a run from this template' })
  async dispatch(
    @Access() access: AccessContext,
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(zodPipe(dispatchWorkflowSchema)) body: DispatchWorkflowInput,
  ): Promise<{ runId: string; number: number; htmlUrl: string }> {
    const config = await this.load(access, id);
    if (!config.enabled) throw ApiError.conflict('This template is disabled');
    const installation = await this.github.requireInstallation(access.organizationId);
    const repo = this.github.assertRepoAccess(installation, config.repoFullName);

    const { inputs, errors } = resolveDispatchInputs(
      config.inputsSchema as WorkflowInputs,
      config.defaultInputs,
      body.inputs,
    );
    if (errors.length) throw ApiError.badRequest('Invalid workflow inputs', errors);

    const ref = body.ref ?? config.ref;
    const dispatched = await this.github
      .client()
      .dispatchWorkflow(installation.installationId, repo, config.workflowFile, ref, inputs)
      .catch((error: unknown) => {
        if (error instanceof GitHubApiError && error.status === 422) {
          throw ApiError.badRequest(`GitHub refused the dispatch: ${error.message}`);
        }
        throw error;
      });

    const run = await this.tenant.withOrg(
      { organizationId: access.organizationId, userId: user.id },
      (tx) =>
        createDispatchedRun(tx, {
          organizationId: access.organizationId,
          projectId: access.projectId!,
          trigger: 'manual',
          ref,
          workflowFile: config.workflowFile,
          githubWorkflowRunId: dispatched.workflow_run_id,
          inputs,
          workflowConfigId: config.id,
          triggeredByUserId: user.id,
        }),
    );
    return { runId: run.id, number: run.number, htmlUrl: dispatched.html_url };
  }

  private async load(access: AccessContext, id: string) {
    const rows = await this.tenant.withOrg({ organizationId: access.organizationId }, (tx) =>
      tx
        .select()
        .from(schema.workflowConfigs)
        .where(
          and(
            eq(schema.workflowConfigs.id, id),
            eq(schema.workflowConfigs.projectId, access.projectId!),
          ),
        )
        .limit(1),
    );
    if (!rows[0]) throw ApiError.notFound('Workflow template');
    return rows[0];
  }

  private async readInputs(
    installation: InstallationRow,
    repo: string,
    file: string,
    ref: string,
  ): Promise<WorkflowInputs> {
    const fullName = this.github.assertRepoAccess(installation, repo);
    const source = await this.github
      .client()
      .getFile(installation.installationId, fullName, `.github/workflows/${file}`, ref)
      .catch((error: unknown) => {
        if (error instanceof GitHubApiError && error.status === 404) {
          throw ApiError.notFound(`Workflow ${file} at ${ref}`);
        }
        throw error;
      });
    let doc: unknown;
    try {
      doc = parseYaml(source);
    } catch {
      throw ApiError.conflict(`${file} is not valid YAML`);
    }
    const inputs = extractDispatchInputs(doc);
    if (inputs === null) {
      throw ApiError.conflict(
        `${file} has no workflow_dispatch trigger and cannot be run from here`,
      );
    }
    return inputs;
  }
}
