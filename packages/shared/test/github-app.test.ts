import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  extractDispatchInputs,
  GitHubApp,
  signWebhookBody,
  verifyWebhookSignature,
} from '../src/node';

describe('webhook signatures', () => {
  it('accepts the HMAC GitHub sends and nothing else', () => {
    const body = '{"action":"ping"}';
    const good = signWebhookBody('s3cret', body);
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('s3cret', body, good)).toBe(true);
    expect(verifyWebhookSignature('s3cret', body + ' ', good)).toBe(false);
    expect(verifyWebhookSignature('other', body, good)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha1=abc')).toBe(false);
  });
});

describe('app JWT', () => {
  it('is RS256 with the app id as issuer and a short expiry', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    // Both the PEM and its base64 form must work: env vars hate newlines.
    for (const key of [pem, Buffer.from(pem).toString('base64')]) {
      const jwt = new GitHubApp({ appId: '42', privateKey: key }).appJwt(1_000_000);
      const [header, payload] = jwt.split('.');
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
        alg: 'RS256',
        typ: 'JWT',
      });
      expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
        iat: 1_000_000 - 60,
        exp: 1_000_000 + 540,
        iss: '42',
      });
    }
  });
});

describe('extractDispatchInputs', () => {
  it('distinguishes "not dispatchable" from "no inputs"', () => {
    expect(extractDispatchInputs(parse('on: push'))).toBeNull();
    expect(extractDispatchInputs(parse('on: [push, pull_request]'))).toBeNull();
    expect(extractDispatchInputs(parse('on: workflow_dispatch'))).toEqual({});
    expect(extractDispatchInputs(parse('on: [push, workflow_dispatch]'))).toEqual({});
    expect(extractDispatchInputs(parse('on:\n  workflow_dispatch:\n  push:'))).toEqual({});
  });

  it('normalizes each input with defaults GitHub would apply', () => {
    const doc = parse(`
on:
  workflow_dispatch:
    inputs:
      env:
        type: choice
        options: [staging, prod]
        default: staging
        description: Where
      verbose:
        type: boolean
      tag:
        required: true
`);
    expect(extractDispatchInputs(doc)).toEqual({
      env: {
        type: 'choice',
        options: ['staging', 'prod'],
        default: 'staging',
        description: 'Where',
        required: false,
      },
      verbose: { type: 'boolean', required: false },
      tag: { type: 'string', required: true },
    });
  });
});

describe('dispatchWorkflow', () => {
  it('uses the run id GitHub returns, or polls for it when the body is empty', async () => {
    const { createServer } = await import('node:http');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: string[] = [];
    let emptyBody = false;
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url?.includes('/access_tokens')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3.6e6) }));
      }
      if (req.url?.endsWith('/dispatches')) {
        if (emptyBody) return res.writeHead(204).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ workflow_run_id: 11, run_url: 'r', html_url: 'h' }));
      }
      if (req.url?.includes('/runs?event=workflow_dispatch')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ workflow_runs: [{ id: 22, url: 'r2', html_url: 'h2' }] }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const app = new GitHubApp({
      appId: '1',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      apiUrl: `http://127.0.0.1:${port}`,
    });
    const noSleep = async () => {};

    const direct = await app.dispatchWorkflow(1, 'o/r', 'e2e.yml', 'main', {}, noSleep);
    expect(direct.workflow_run_id).toBe(11);
    expect(calls.filter((c) => c.includes('/runs?'))).toHaveLength(0);

    emptyBody = true;
    const polled = await app.dispatchWorkflow(1, 'o/r', 'e2e.yml', 'main', {}, noSleep);
    expect(polled.workflow_run_id).toBe(22);
    expect(calls.at(-1)).toMatch(
      /\/actions\/workflows\/e2e\.yml\/runs\?event=workflow_dispatch&branch=main&created=/,
    );
    server.close();
  });
});

describe('resolveDispatchInputs', () => {
  it('treats empty as absent, drops stale defaults, rejects unknown caller keys', async () => {
    const { resolveDispatchInputs } = await import('../src/index');
    const declared = {
      env: { type: 'choice' as const, required: true, options: ['a', 'b'], default: 'a' },
      n: { type: 'number' as const, required: false, default: 0 },
    };
    expect(resolveDispatchInputs(declared, { gone: 'x' }, { env: '' })).toEqual({
      inputs: { env: 'a', n: '0' },
      errors: [],
    });
    expect(resolveDispatchInputs(declared, {}, { nope: '1', n: 'abc' }).errors).toEqual([
      '"nope" is not an input of this workflow',
      '"n" must be a number',
    ]);
  });
});
