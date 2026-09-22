import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SystemDb, TenantDb, schema } from '@eyesonbug/db';
import { processGithubEvent } from '../src/jobs/github';

/**
 * Webhook deliveries are folded by GitHub's own ids, so a redelivery must be
 * a no-op and a delivery for a run the reporter already sealed must not reopen
 * it. Both are asserted here against the real tables.
 */
describe('github event processing', () => {
  const INSTALLATION_ID = 777_001;
  const WORKFLOW_RUN_ID = 900_001;
  let system: SystemDb;
  let tenant: TenantDb;
  let organizationId: string;
  let projectId: string;
  let runId: string;

  beforeAll(async () => {
    system = new SystemDb({
      url:
        process.env.DATABASE_MIGRATION_URL ??
        'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug',
      max: 2,
    });
    tenant = new TenantDb({
      url:
        process.env.DATABASE_URL ??
        'postgres://eyesonbug_app:eyesonbug_app@localhost:5432/eyesonbug',
      max: 2,
    });
    const rows = await system.db
      .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.slug, 'storefront'))
      .limit(1);
    projectId = rows[0]!.id;
    organizationId = rows[0]!.organizationId;

    await system.db.insert(schema.githubInstallations).values({
      organizationId,
      installationId: INSTALLATION_ID,
      accountLogin: 'acme-retail',
      repositories: ['acme-retail/storefront', 'acme-retail/docs'],
    });
    const [run] = await system.db
      .insert(schema.runs)
      .values({
        organizationId,
        projectId,
        number: 999_001,
        status: 'queued',
        trigger: 'manual',
        githubWorkflowRunId: WORKFLOW_RUN_ID,
      })
      .returning({ id: schema.runs.id });
    runId = run!.id;
  });

  afterAll(async () => {
    await system.db.delete(schema.runs).where(eq(schema.runs.id, runId));
    await system.db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, INSTALLATION_ID));
    await tenant.close();
    await system.close();
  });

  const installation = () =>
    system.db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, INSTALLATION_ID))
      .then((rows) => rows[0]);

  const run = () =>
    system.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .then((rows) => rows[0]!);

  it('tracks repositories added to and removed from the installation', async () => {
    await processGithubEvent(system, tenant, {
      event: 'installation_repositories',
      deliveryId: 'd-1',
      payload: {
        action: 'added',
        installation: { id: INSTALLATION_ID },
        repositories_added: [{ full_name: 'acme-retail/mobile' }],
        repositories_removed: [{ full_name: 'acme-retail/docs' }],
      },
    });
    expect((await installation())?.repositories).toEqual([
      'acme-retail/storefront',
      'acme-retail/mobile',
    ]);
  });

  it('suspends and unsuspends', async () => {
    const suspend = { installation: { id: INSTALLATION_ID } };
    await processGithubEvent(system, tenant, {
      event: 'installation',
      deliveryId: 'd-2',
      payload: { action: 'suspend', ...suspend },
    });
    expect((await installation())?.suspendedAt).toBeInstanceOf(Date);
    await processGithubEvent(system, tenant, {
      event: 'installation',
      deliveryId: 'd-3',
      payload: { action: 'unsuspend', ...suspend },
    });
    expect((await installation())?.suspendedAt).toBeNull();
  });

  it('ignores an installation no organization has linked', async () => {
    await expect(
      processGithubEvent(system, tenant, {
        event: 'installation',
        deliveryId: 'd-4',
        payload: { action: 'deleted', installation: { id: 1 } },
      }),
    ).resolves.toBeUndefined();
  });

  const workflowRun = (action: string, extra: Record<string, unknown> = {}) => ({
    event: 'workflow_run',
    deliveryId: `wr-${action}`,
    payload: {
      action,
      workflow_run: {
        id: WORKFLOW_RUN_ID,
        name: 'e2e',
        run_attempt: 1,
        status: action === 'completed' ? 'completed' : action,
        conclusion: null,
        head_branch: 'feat/checkout',
        head_sha: 'abc123',
        run_started_at: '2026-09-22T10:00:00Z',
        updated_at: '2026-09-22T10:05:00Z',
        head_commit: { message: 'checkout: fix totals', author: { name: 'Sam' } },
        ...extra,
      },
    },
  });

  it('fills the run from workflow_run and moves queued → running', async () => {
    await processGithubEvent(system, tenant, workflowRun('in_progress'));
    const row = await run();
    expect(row.status).toBe('running');
    expect(row.branch).toBe('feat/checkout');
    expect(row.commitSha).toBe('abc123');
    expect(row.commitMessage).toBe('checkout: fix totals');
    expect(row.githubRunAttempt).toBe(1);
    expect(row.startedAt?.toISOString()).toBe('2026-09-22T10:00:00.000Z');
  });

  it('marks a run that never reported as errored when the job fails', async () => {
    await processGithubEvent(system, tenant, workflowRun('completed', { conclusion: 'failure' }));
    expect((await run()).status).toBe('errored');
  });

  it('never reopens a sealed run', async () => {
    await processGithubEvent(system, tenant, workflowRun('in_progress', { head_sha: 'later' }));
    const row = await run();
    expect(row.status).toBe('errored');
    expect(row.commitSha).toBe('abc123');
  });
});
