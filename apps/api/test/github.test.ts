import { createServer, type Server as HttpServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { SystemDb, schema } from '@eyesonbug/db';
import { signWebhookBody } from '@eyesonbug/shared/node';
import IORedis from 'ioredis';
import { installerKey } from '../src/github/github.service';

/**
 * The GitHub back office against a fake GitHub.
 *
 * A stub that answers the handful of endpoints we call is enough to prove the
 * routes authenticate as the App, scope repositories to the installation and
 * refuse forged webhooks. The client itself is checked against the real
 * documentation, not against this stub.
 */
const WEBHOOK_SECRET = 'test-webhook-secret';
const INSTALLATION_ID = 4242;
const WORKFLOW_RUN_ID = 555_001;

const E2E_WORKFLOW = `
name: e2e
on:
  push:
  workflow_dispatch:
    inputs:
      environment:
        description: Target
        type: choice
        options: [staging, production]
        default: staging
      shards:
        type: number
        default: 4
      smoke:
        type: boolean
        required: true
`;

function fakeGithub(): Promise<{
  server: HttpServer;
  url: string;
  calls: string[];
  bodies: unknown[];
}> {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    const line = `${req.method} ${req.url}`;
    calls.push(line);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!req.headers.authorization?.startsWith('Bearer ')) return json(401, { message: 'no auth' });

    if (line === `POST /app/installations/${INSTALLATION_ID}/access_tokens`) {
      return json(201, { token: 'ghs_fake', expires_at: new Date(Date.now() + 3_600_000) });
    }
    if (line === `GET /app/installations/${INSTALLATION_ID}`) {
      return json(200, {
        id: INSTALLATION_ID,
        account: { login: 'acme-retail', type: 'Organization' },
        suspended_at: null,
        repository_selection: 'selected',
      });
    }
    if (line.startsWith('GET /app/installations/')) return json(404, { message: 'Not Found' });
    if (line.startsWith('GET /installation/repositories')) {
      return json(200, {
        repositories: [
          { id: 1, full_name: 'acme-retail/storefront', default_branch: 'main', private: true },
        ],
      });
    }
    if (line.startsWith('GET /repos/acme-retail/storefront/actions/workflows')) {
      return json(200, {
        workflows: [{ id: 7, name: 'e2e', path: '.github/workflows/e2e.yml', state: 'active' }],
      });
    }
    if (line.startsWith('GET /repos/acme-retail/storefront/contents/.github/workflows/e2e.yml')) {
      res.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      return res.end(E2E_WORKFLOW);
    }
    if (line === 'POST /repos/acme-retail/storefront/actions/workflows/e2e.yml/dispatches') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        json(200, {
          workflow_run_id: WORKFLOW_RUN_ID,
          run_url: `${req.headers.host}/runs/${WORKFLOW_RUN_ID}`,
          html_url: `https://github.com/acme-retail/storefront/actions/runs/${WORKFLOW_RUN_ID}`,
        });
      });
      return;
    }
    if (line === `POST /repos/acme-retail/storefront/actions/runs/${WORKFLOW_RUN_ID}/cancel`) {
      return json(202, {});
    }
    if (
      line.startsWith(`POST /repos/acme-retail/storefront/actions/runs/${WORKFLOW_RUN_ID}/rerun`)
    ) {
      return json(201, {});
    }
    return json(404, { message: `unhandled ${line}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}`, calls, bodies });
    });
  });
}

describe('GitHub back office', () => {
  let app: NestFastifyApplication;
  let server: Server;
  let github: Awaited<ReturnType<typeof fakeGithub>>;
  let system: SystemDb;
  let redis: IORedis;

  const login = async (email: string) => {
    const agent = request.agent(server);
    const response = await agent.post('/v1/auth/dev-login').send({ email });
    expect(response.status, `dev-login failed for ${email}`).toBe(201);
    return agent;
  };

  beforeAll(async () => {
    github = await fakeGithub();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_SLUG = 'eyesonbug-test';
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.GITHUB_API_URL = github.url;

    // Imported after the environment is set: `env()` is validated once.
    const { createApp } = await import('../src/main.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpServer() as Server;
    system = new SystemDb({
      url:
        process.env.DATABASE_MIGRATION_URL ??
        'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug',
      max: 2,
    });
    redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    await system.db.delete(schema.runs).where(eq(schema.runs.githubWorkflowRunId, WORKFLOW_RUN_ID));
    await system.db
      .delete(schema.workflowConfigs)
      .where(eq(schema.workflowConfigs.name, 'Nightly e2e'));
    await system.db.delete(schema.qualityGates).where(eq(schema.qualityGates.name, 'Main gate'));
    await system.db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, INSTALLATION_ID));
    await redis.del(installerKey(INSTALLATION_ID));
    redis.disconnect();
    await system.close();
    await app.close();
    github.server.close();
  });

  it('is admin-only', async () => {
    const viewer = await login('viewer@eyesonbug.dev');
    const response = await viewer.get('/v1/o/acme-retail/github/installation');
    expect(response.status).toBe(403);
  });

  it('builds an install URL that carries the org back', async () => {
    const admin = await login('demo@eyesonbug.dev');
    const response = await admin.get('/v1/o/acme-retail/github/install-url');
    expect(response.status).toBe(200);
    expect(response.body.url).toBe(
      'https://github.com/apps/eyesonbug-test/installations/new?state=acme-retail',
    );
  });

  it('refuses to link an installation GitHub does not know', async () => {
    const admin = await login('demo@eyesonbug.dev');
    const [demo] = await system.db
      .select({ githubUserId: schema.users.githubUserId })
      .from(schema.users)
      .where(eq(schema.users.email, 'demo@eyesonbug.dev'));
    await redis.set(installerKey(999), String(demo!.githubUserId));
    const response = await admin
      .post('/v1/o/acme-retail/github/installation')
      .send({ installationId: 999 });
    expect(response.status).toBe(404);
    await redis.del(installerKey(999));
  });

  it('refuses to link an installation the caller did not install', async () => {
    const admin = await login('demo@eyesonbug.dev');
    // GitHub knows the installation, but no `installation.created` webhook
    // named this user as its installer.
    const unknown = await admin
      .post('/v1/o/acme-retail/github/installation')
      .send({ installationId: INSTALLATION_ID });
    expect(unknown.status).toBe(403);

    await redis.set(installerKey(INSTALLATION_ID), '1');
    const someoneElse = await admin
      .post('/v1/o/acme-retail/github/installation')
      .send({ installationId: INSTALLATION_ID });
    expect(someoneElse.status).toBe(403);
  });

  it('links an installation after verifying it as the App', async () => {
    const admin = await login('demo@eyesonbug.dev');
    const [demo] = await system.db
      .select({ githubUserId: schema.users.githubUserId })
      .from(schema.users)
      .where(eq(schema.users.email, 'demo@eyesonbug.dev'));
    await redis.set(installerKey(INSTALLATION_ID), String(demo!.githubUserId));
    const response = await admin
      .post('/v1/o/acme-retail/github/installation')
      .send({ installationId: INSTALLATION_ID });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      installationId: INSTALLATION_ID,
      accountLogin: 'acme-retail',
      repositories: ['acme-retail/storefront'],
    });
    // The lookup ran with the App JWT, the repo listing with an installation token.
    expect(github.calls).toContain(`GET /app/installations/${INSTALLATION_ID}`);
    expect(github.calls).toContain(`POST /app/installations/${INSTALLATION_ID}/access_tokens`);

    const shown = await admin.get('/v1/o/acme-retail/github/installation');
    expect(shown.body.installation.installationId).toBe(INSTALLATION_ID);
  });

  it('keeps the installation invisible to another tenant', async () => {
    const outsider = await login('outsider@northwind.dev');
    const response = await outsider.get('/v1/o/northwind/github/installation');
    expect(response.status).toBe(200);
    expect(response.body.installation).toBeNull();
  });

  it('lists workflows and generates the launcher inputs from the workflow file', async () => {
    const admin = await login('demo@eyesonbug.dev');
    const workflows = await admin.get(
      '/v1/o/acme-retail/github/repos/acme-retail/storefront/workflows',
    );
    expect(workflows.status).toBe(200);
    expect(workflows.body).toEqual([{ id: 7, name: 'e2e', file: 'e2e.yml', state: 'active' }]);

    const inputs = await admin.get(
      '/v1/o/acme-retail/github/repos/acme-retail/storefront/workflows/e2e.yml/inputs',
    );
    expect(inputs.status).toBe(200);
    expect(inputs.body).toEqual({
      dispatchable: true,
      inputs: {
        environment: {
          type: 'choice',
          description: 'Target',
          required: false,
          default: 'staging',
          options: ['staging', 'production'],
        },
        shards: { type: 'number', required: false, default: 4 },
        smoke: { type: 'boolean', required: true },
      },
    });
  });

  it('only reaches repositories the installation was granted', async () => {
    const admin = await login('demo@eyesonbug.dev');
    const response = await admin.get(
      '/v1/o/acme-retail/github/repos/acme-retail/secrets/workflows',
    );
    expect(response.status).toBe(404);
  });

  describe('webhooks', () => {
    const body = JSON.stringify({ action: 'suspend', installation: { id: INSTALLATION_ID } });
    const headers = { 'x-github-event': 'installation', 'x-github-delivery': 'd-1' };

    it('rejects a missing or forged signature', async () => {
      const unsigned = await request(server)
        .post('/v1/webhooks/github')
        .set(headers)
        .set('content-type', 'application/json')
        .send(body);
      expect(unsigned.status).toBe(401);

      const forged = await request(server)
        .post('/v1/webhooks/github')
        .set(headers)
        .set('x-hub-signature-256', signWebhookBody('wrong-secret', body))
        .set('content-type', 'application/json')
        .send(body);
      expect(forged.status).toBe(401);
    });

    it('accepts a correctly signed delivery', async () => {
      const response = await request(server)
        .post('/v1/webhooks/github')
        .set(headers)
        .set('x-hub-signature-256', signWebhookBody(WEBHOOK_SECRET, body))
        .set('content-type', 'application/json')
        .send(body);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ queued: true });
    });

    it('acknowledges events it does not handle without queueing them', async () => {
      const response = await request(server)
        .post('/v1/webhooks/github')
        .set({ 'x-github-event': 'star', 'x-github-delivery': 'd-2' })
        .set('x-hub-signature-256', signWebhookBody(WEBHOOK_SECRET, body))
        .set('content-type', 'application/json')
        .send(body);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ queued: false });
    });
  });

  describe('workflow templates and dispatch', () => {
    const base = '/v1/o/acme-retail/p/storefront';
    let configId: string;
    let runId: string;

    it('needs workflow:manage to create a template', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const response = await qa.post(`${base}/workflow-configs`).send({
        name: 'Nightly e2e',
        repoFullName: 'acme-retail/storefront',
        workflowFile: 'e2e.yml',
      });
      expect(response.status).toBe(403);
    });

    it('creates a template with the inputs read from the workflow file', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const response = await admin.post(`${base}/workflow-configs`).send({
        name: 'Nightly e2e',
        repoFullName: 'acme-retail/storefront',
        workflowFile: 'e2e.yml',
        defaultInputs: { environment: 'production' },
      });
      expect(response.status).toBe(201);
      expect(Object.keys(response.body.inputsSchema).sort()).toEqual([
        'environment',
        'shards',
        'smoke',
      ]);
      configId = response.body.id;

      const listed = await admin.get(`${base}/workflow-configs`);
      expect(listed.body.map((c: { id: string }) => c.id)).toContain(configId);
    });

    it('refuses a repository outside the installation', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const response = await admin.post(`${base}/workflow-configs`).send({
        name: 'Elsewhere',
        repoFullName: 'acme-retail/secrets',
        workflowFile: 'e2e.yml',
      });
      expect(response.status).toBe(404);
    });

    it('validates inputs against the workflow before calling GitHub', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const response = await qa
        .post(`${base}/workflow-configs/${configId}/dispatch`)
        .send({ inputs: { environment: 'moon', bogus: '1' } });
      expect(response.status).toBe(400);
      expect([...response.body.error.details].sort()).toEqual([
        '"bogus" is not an input of this workflow',
        '"environment" must be one of staging, production',
        '"smoke" is required',
      ]);
      expect(github.calls.filter((c) => c.includes('/dispatches'))).toHaveLength(0);
    });

    it('dispatches and creates the run with the id GitHub returns', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const response = await qa
        .post(`${base}/workflow-configs/${configId}/dispatch`)
        .send({ inputs: { smoke: 'true' } });
      expect(response.status).toBe(201);
      expect(response.body.htmlUrl).toContain(String(WORKFLOW_RUN_ID));
      runId = response.body.runId;

      // Defaults from the template and the workflow file were merged in.
      expect(github.bodies.at(-1)).toEqual({
        ref: 'main',
        inputs: { environment: 'production', shards: '4', smoke: 'true' },
      });

      const run = await qa.get(`${base}/runs/${runId}`);
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ status: 'queued', trigger: 'manual', branch: 'main' });
    });

    it('cancels on GitHub as well as here', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const response = await qa.post(`${base}/runs/${runId}/cancel`);
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ status: 'cancelled', githubCancelled: true });
      expect(github.calls).toContain(
        `POST /repos/acme-retail/storefront/actions/runs/${WORKFLOW_RUN_ID}/cancel`,
      );
    });

    it('re-runs failed jobs as a new attempt linked to the original', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const response = await qa.post(`${base}/runs/${runId}/rerun`).send({ kind: 'failed' });
      expect(response.status).toBe(201);
      expect(github.calls).toContain(
        `POST /repos/acme-retail/storefront/actions/runs/${WORKFLOW_RUN_ID}/rerun-failed-jobs`,
      );
      const rerun = await qa.get(`${base}/runs/${response.body.runId}`);
      expect(rerun.body).toMatchObject({
        status: 'queued',
        rerunOfRunId: runId,
        rerunKind: 'failed',
      });
    });

    it('will not re-run a run that is still going', async () => {
      const qa = await login('qa@eyesonbug.dev');
      const queued = await qa.get(`${base}/runs`);
      const running = queued.body.items.find((r: { status: string }) => r.status === 'queued');
      const response = await qa.post(`${base}/runs/${running.id}/rerun`).send({ kind: 'all' });
      expect(response.status).toBe(409);
    });

    it('lets a viewer see templates but not launch them', async () => {
      const viewer = await login('viewer@eyesonbug.dev');
      expect((await viewer.get(`${base}/workflow-configs`)).status).toBe(200);
      const response = await viewer.post(`${base}/workflow-configs/${configId}/dispatch`).send({});
      expect(response.status).toBe(403);
    });
  });

  describe('schedules and quality gates', () => {
    const base = '/v1/o/acme-retail/p/storefront';
    let configId: string;

    it('needs schedule:manage to create a schedule', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const configs = await admin.get(`${base}/workflow-configs`);
      configId = configs.body.find((c: { name: string }) => c.name === 'Nightly e2e').id;

      const qa = await login('qa@eyesonbug.dev');
      const response = await qa
        .post(`${base}/schedules`)
        .send({ name: 'Nightly', workflowConfigId: configId, cron: '0 2 * * *' });
      expect(response.status).toBe(403);
    });

    it('rejects an invalid cron or timezone with a 400', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const cron = await admin
        .post(`${base}/schedules`)
        .send({ name: 'Bad', workflowConfigId: configId, cron: '99 99 * * *' });
      expect(cron.status).toBe(400);
      const zone = await admin.post(`${base}/schedules`).send({
        name: 'Bad',
        workflowConfigId: configId,
        cron: '0 2 * * *',
        timezone: 'Mars/Olympus',
      });
      expect(zone.status).toBe(400);
    });

    it('creates a schedule with its next run computed in the given zone', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const response = await admin.post(`${base}/schedules`).send({
        name: 'Nightly',
        workflowConfigId: configId,
        cron: '0 2 * * *',
        timezone: 'Europe/Paris',
        inputs: { smoke: 'true' },
      });
      expect(response.status).toBe(201);
      expect(new Date(response.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());

      const disabled = await admin
        .patch(`${base}/schedules/${response.body.id}`)
        .send({ enabled: false });
      expect(disabled.body.nextRunAt).toBeNull();

      const removed = await admin.delete(`${base}/schedules/${response.body.id}`);
      expect(removed.status).toBe(204);
    });

    it('refuses a schedule for a template in another project', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const response = await admin.post('/v1/o/acme-retail/p/mobile/schedules').send({
        name: 'Elsewhere',
        workflowConfigId: configId,
        cron: '0 2 * * *',
      });
      expect([404, 403]).toContain(response.status);
    });

    it('manages quality gates', async () => {
      const admin = await login('demo@eyesonbug.dev');
      const created = await admin.post(`${base}/quality-gates`).send({
        name: 'Main gate',
        rules: { minPassRate: 0.95, maxFailed: 0 },
        appliesToBranches: ['main', 'release/*'],
      });
      expect(created.status).toBe(201);

      const bad = await admin
        .post(`${base}/quality-gates`)
        .send({ name: 'Nope', rules: { minPassRate: 2 } });
      expect(bad.status).toBe(400);

      const dup = await admin.post(`${base}/quality-gates`).send({ name: 'Main gate' });
      expect(dup.status).toBe(409);

      const viewer = await login('viewer@eyesonbug.dev');
      const listed = await viewer.get(`${base}/quality-gates`);
      expect(listed.body.map((g: { name: string }) => g.name)).toContain('Main gate');
      const forbidden = await viewer
        .patch(`${base}/quality-gates/${created.body.id}`)
        .send({ enabled: false });
      expect(forbidden.status).toBe(403);
    });
  });
});
