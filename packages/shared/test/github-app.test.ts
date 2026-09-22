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
