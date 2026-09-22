import { createServer, type Server as HttpServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { SystemDb, schema } from '@eyesonbug/db';
import { signWebhookBody } from '@eyesonbug/shared/node';

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

function fakeGithub(): Promise<{ server: HttpServer; url: string; calls: string[] }> {
  const calls: string[] = [];
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
    return json(404, { message: `unhandled ${line}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}`, calls });
    });
  });
}

describe('GitHub back office', () => {
  let app: NestFastifyApplication;
  let server: Server;
  let github: Awaited<ReturnType<typeof fakeGithub>>;
  let system: SystemDb;

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
  });

  afterAll(async () => {
    await system.db
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, INSTALLATION_ID));
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
    const response = await admin
      .post('/v1/o/acme-retail/github/installation')
      .send({ installationId: 999 });
    expect(response.status).toBe(404);
  });

  it('links an installation after verifying it as the App', async () => {
    const admin = await login('demo@eyesonbug.dev');
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
});
