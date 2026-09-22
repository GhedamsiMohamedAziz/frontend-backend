import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { createApp } from '../src/main';

/**
 * End-to-end checks against the seeded database.
 *
 * These exercise the two things M0 has to get right: a request cannot reach
 * data without a session, and a session cannot reach data its role does not
 * allow. Both are asserted against the real HTTP surface rather than against
 * the services, because the guards are the thing under test.
 */
describe('API', () => {
  let app: NestFastifyApplication;
  let server: Server;

  const login = async (email: string) => {
    const agent = request.agent(server);
    const response = await agent.post('/v1/auth/dev-login').send({ email });
    expect(response.status, `dev-login failed for ${email}`).toBe(201);
    return agent;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('ops', () => {
    it('serves liveness without a session', async () => {
      const response = await request(server).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });

    it('reports readiness including the database', async () => {
      const response = await request(server).get('/ready');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ready', checks: { database: true } });
    });

    it('publishes an OpenAPI document', async () => {
      const response = await request(server).get('/v1/openapi.json');
      expect(response.status).toBe(200);
      expect(response.body.info.title).toBe('EyesOnBug API');
      expect(Object.keys(response.body.paths)).toContain('/v1/me');
    });
  });

  describe('authentication', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await request(server).get('/v1/me');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    });

    it('refuses a forged session cookie', async () => {
      const response = await request(server)
        .get('/v1/me')
        .set('Cookie', 'eob_session=not-a-real-token');
      expect(response.status).toBe(401);
    });

    it('returns the whole authorization picture in one call', async () => {
      const agent = await login('demo@eyesonbug.dev');
      const response = await agent.get('/v1/me');

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe('demo@eyesonbug.dev');
      expect(response.body.organizations).toHaveLength(1);
      expect(response.body.organizations[0].slug).toBe('acme-retail');
      expect(response.body.projects.map((p: { slug: string }) => p.slug).sort()).toEqual([
        'checkout-api',
        'mobile-web',
        'storefront',
      ]);
    });

    it('ends the session on logout', async () => {
      const agent = await login('demo@eyesonbug.dev');
      expect((await agent.get('/v1/me')).status).toBe(200);
      await agent.post('/v1/auth/logout');
      expect((await agent.get('/v1/me')).status).toBe(401);
    });
  });

  describe('tenant boundaries', () => {
    it('reports another tenant project as missing, not forbidden', async () => {
      // 403 would confirm the project exists. For a resource in someone else's
      // organization that is itself a disclosure, so the answer is 404.
      const agent = await login('outsider@northwind.dev');
      const response = await agent.get('/v1/o/acme-retail/p/storefront');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    });

    it('shows a member only their own organization projects', async () => {
      const agent = await login('outsider@northwind.dev');
      const response = await agent.get('/v1/me');
      expect(response.body.projects.map((p: { slug: string }) => p.slug)).toEqual([
        'northwind-shop',
      ]);
    });
  });

  describe('role-based access control', () => {
    it('gives a viewer read access and nothing more', async () => {
      const agent = await login('viewer@eyesonbug.dev');

      const read = await agent.get('/v1/o/acme-retail/p/storefront');
      expect(read.status).toBe(200);
      expect(read.body.role).toBe('viewer');
      expect(read.body.capabilities).toEqual(['project:read']);

      const write = await agent
        .patch('/v1/o/acme-retail/p/storefront')
        .send({ name: 'Renamed by a viewer' });
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe('forbidden');
    });

    it('lets QA act on results but not mint tokens', async () => {
      const agent = await login('qa@eyesonbug.dev');

      const detail = await agent.get('/v1/o/acme-retail/p/storefront');
      expect(detail.body.role).toBe('qa');
      expect(detail.body.capabilities).toContain('triage:write');
      expect(detail.body.capabilities).not.toContain('token:manage');

      const tokens = await agent.get('/v1/o/acme-retail/p/storefront/tokens');
      expect(tokens.status).toBe(403);
    });

    it('lets a maintainer configure the project but not manage members', async () => {
      const agent = await login('dev@eyesonbug.dev');
      const detail = await agent.get('/v1/o/acme-retail/p/storefront');

      expect(detail.body.role).toBe('maintainer');
      expect(detail.body.capabilities).toContain('workflow:manage');
      expect(detail.body.capabilities).not.toContain('member:manage');
    });

    it('promotes an org owner to admin on every project without an explicit grant', async () => {
      const agent = await login('demo@eyesonbug.dev');
      const detail = await agent.get('/v1/o/acme-retail/p/storefront');

      expect(detail.body.role).toBeNull(); // no project_membership row
      expect(detail.body.capabilities).toContain('member:manage');
      expect(detail.body.capabilities).toContain('token:manage');
    });
  });

  describe('API tokens', () => {
    it('returns the secret exactly once and never lists it again', async () => {
      const agent = await login('demo@eyesonbug.dev');

      const created = await agent
        .post('/v1/o/acme-retail/p/storefront/tokens')
        .send({ name: 'test token', scopes: ['ingest:write'] });

      expect(created.status).toBe(201);
      expect(created.body.token).toMatch(/^eob_/);

      const listed = await agent.get('/v1/o/acme-retail/p/storefront/tokens');
      const found = (listed.body as Array<{ id: string; tokenPrefix: string }>).find(
        (t) => t.id === created.body.id,
      );

      expect(found).toBeDefined();
      expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
      expect(found!.tokenPrefix).toBe((created.body.token as string).slice(0, 12));

      await agent.delete(`/v1/o/acme-retail/p/storefront/tokens/${created.body.id}`);
      const after = await agent.get('/v1/o/acme-retail/p/storefront/tokens');
      expect((after.body as Array<{ id: string }>).some((t) => t.id === created.body.id)).toBe(
        false,
      );
    });
  });

  describe('validation', () => {
    it('rejects a malformed body with field-level detail', async () => {
      const agent = await login('demo@eyesonbug.dev');
      const response = await agent
        .patch('/v1/o/acme-retail/p/storefront')
        .send({ defaultBranch: '' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('bad_request');
      expect(response.body.error.details[0].path).toBe('defaultBranch');
    });

    it('rejects unknown fields rather than silently ignoring them', async () => {
      const agent = await login('demo@eyesonbug.dev');
      const response = await agent
        .patch('/v1/o/acme-retail/p/storefront')
        .send({ organizationId: '00000000-0000-0000-0000-000000000000' });

      expect(response.status).toBe(400);
    });
  });
});
