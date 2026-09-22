import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { SystemDb, TenantDb, schema } from '@eyesonbug/db';
import { GitHubApp } from '@eyesonbug/shared/node';
import { tickSchedules } from '../src/jobs/schedules';
import { evaluateGate } from '../src/jobs/gates';

/**
 * Schedules and gates against a fake GitHub. The tick must dispatch a due
 * schedule exactly once and advance it; the gate must be evaluated exactly
 * once when a run seals and reported as a check run on its commit.
 */
describe('schedules and quality gates', () => {
  const INSTALLATION_ID = 777_002;
  let system: SystemDb;
  let tenant: TenantDb;
  let github: GitHubApp;
  let server: Server;
  let organizationId: string;
  let projectId: string;
  let configId: string;
  let scheduleId: string;
  let gateId: string;
  const calls: Array<{ line: string; body: unknown }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk));
      req.on('end', () => {
        const line = `${req.method} ${req.url}`;
        calls.push({ line, body: raw ? JSON.parse(raw) : null });
        res.writeHead(line.includes('/dispatches') || line.includes('/check-runs') ? 201 : 200, {
          'content-type': 'application/json',
        });
        if (line.includes('/access_tokens')) {
          res.end(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000) }));
        } else if (line.includes('/dispatches')) {
          res.end(JSON.stringify({ workflow_run_id: 4242, run_url: '', html_url: '' }));
        } else if (line.includes('/check-runs')) {
          res.end(JSON.stringify({ id: 9001 }));
        } else res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    github = new GitHubApp({
      appId: '1',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      apiUrl: `http://127.0.0.1:${port}`,
    });

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
    const [project] = await system.db
      .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.slug, 'storefront'))
      .limit(1);
    projectId = project!.id;
    organizationId = project!.organizationId;

    await system.db.insert(schema.githubInstallations).values({
      organizationId,
      installationId: INSTALLATION_ID,
      accountLogin: 'acme-retail',
      repositories: ['acme-retail/storefront'],
    });
    const [config] = await system.db
      .insert(schema.workflowConfigs)
      .values({
        organizationId,
        projectId,
        name: 'Automation test',
        repoFullName: 'acme-retail/storefront',
        workflowFile: 'e2e.yml',
        ref: 'main',
        inputsSchema: { smoke: { type: 'boolean', required: false, default: false } },
        defaultInputs: {},
      })
      .returning({ id: schema.workflowConfigs.id });
    configId = config!.id;
    const [schedule] = await system.db
      .insert(schema.schedules)
      .values({
        organizationId,
        projectId,
        workflowConfigId: configId,
        name: 'Nightly',
        cron: '0 2 * * *',
        timezone: 'Europe/Paris',
        inputs: { smoke: 'true' },
        nextRunAt: new Date('2026-09-22T00:00:00Z'),
      })
      .returning({ id: schema.schedules.id });
    scheduleId = schedule!.id;
    const [gate] = await system.db
      .insert(schema.qualityGates)
      .values({
        organizationId,
        projectId,
        name: 'Automation gate',
        rules: { minPassRate: 0.9, maxFailed: 0 },
        appliesToBranches: ['main'],
      })
      .returning({ id: schema.qualityGates.id });
    gateId = gate!.id;
  });

  afterAll(async () => {
    await system.db.delete(schema.schedules).where(eq(schema.schedules.id, scheduleId));
    await system.db.delete(schema.qualityGates).where(eq(schema.qualityGates.id, gateId));
    await system.db.delete(schema.runs).where(inArray(schema.runs.number, [999_010, 999_011]));
    await system.db.delete(schema.runs).where(eq(schema.runs.scheduleId, scheduleId));
    await system.db.delete(schema.workflowConfigs).where(eq(schema.workflowConfigs.id, configId));
    await system.db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, INSTALLATION_ID));
    await tenant.close();
    await system.close();
    server.close();
  });

  it('dispatches a due schedule once and advances it in its own timezone', async () => {
    const now = new Date('2026-09-22T00:01:00Z');
    const first = await tickSchedules(system, tenant, github, now);
    expect(first).toEqual({ dispatched: 1, skipped: 0 });
    expect(calls.find((c) => c.line.includes('/dispatches'))?.body).toEqual({
      ref: 'main',
      inputs: { smoke: 'true' },
    });

    const [schedule] = await system.db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId));
    // 02:00 Europe/Paris on 22 Sep 2026 (CEST, UTC+2) is 00:00 UTC — already
    // past at 00:01, so the next firing is the following day.
    expect(schedule!.nextRunAt?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(schedule!.lastRunAt?.toISOString()).toBe(now.toISOString());

    const runs = await system.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'queued',
      githubWorkflowRunId: 4242,
      dispatchInputs: { smoke: 'true' },
    });

    const second = await tickSchedules(system, tenant, github, now);
    expect(second).toEqual({ dispatched: 0, skipped: 0 });
  });

  it('evaluates the gate once when a run seals and reports a check run', async () => {
    const [run] = await system.db
      .insert(schema.runs)
      .values({
        organizationId,
        projectId,
        number: 999_010,
        status: 'failed',
        trigger: 'push',
        branch: 'main',
        commitSha: 'deadbeef',
        totals: { total: 10, passed: 8, failed: 1, skipped: 0, broken: 0, flaky: 1, running: 0 },
      })
      .returning({ id: schema.runs.id });

    await evaluateGate(system, tenant, github, run!.id, 'https://eob.test');
    const [after] = await system.db.select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(after!.gate).toEqual({
      gateId,
      name: 'Automation gate',
      passed: false,
      reasons: ['1 failed, at most 0 allowed'],
    });
    expect(after!.githubCheckRunId).toBe(9001);

    const check = calls.find((c) => c.line.includes('/check-runs'));
    expect(check?.line).toBe('POST /repos/acme-retail/storefront/check-runs');
    expect(check?.body).toMatchObject({
      name: 'EyesOnBug / Automation gate',
      head_sha: 'deadbeef',
      conclusion: 'failure',
      details_url: `https://eob.test/o/acme-retail/p/storefront/runs/${run!.id}`,
    });

    // A second pass is a no-op.
    const before = calls.length;
    await evaluateGate(system, tenant, github, run!.id, 'https://eob.test');
    expect(calls.length).toBe(before);
  });

  it('leaves a run alone while it is still going, and skips branches the gate does not cover', async () => {
    const [running] = await system.db
      .insert(schema.runs)
      .values({
        organizationId,
        projectId,
        number: 999_011,
        status: 'running',
        trigger: 'push',
        branch: 'feature/x',
        commitSha: 'cafe',
      })
      .returning({ id: schema.runs.id });
    await evaluateGate(system, tenant, github, running!.id, 'https://eob.test');
    let [row] = await system.db.select().from(schema.runs).where(eq(schema.runs.id, running!.id));
    expect(row!.gate).toBeNull();

    await system.db
      .update(schema.runs)
      .set({ status: 'passed' })
      .where(eq(schema.runs.id, running!.id));
    await evaluateGate(system, tenant, github, running!.id, 'https://eob.test');
    [row] = await system.db.select().from(schema.runs).where(eq(schema.runs.id, running!.id));
    expect(row!.gate).toBeNull();
  });
});
