import { createHash, randomBytes } from 'node:crypto';
import {
  canonicalJson,
  errorSignatureParts,
  normalizeFilePath,
  type ErrorSignatureParts,
} from './normalize.js';

/**
 * Node-only half of `@eyesonbug/shared`. Imported by the API, the worker and
 * the reporter; never by the browser bundle, which is why it lives behind the
 * `@eyesonbug/shared/node` subpath rather than in the main entry.
 */

/** Unit separator: cannot appear in a path, title or JSON string. */
const SEP = '\u0000';

/**
 * Hash schemes are versioned. If normalization is ever improved, old rows keep
 * their `v1` identity and a migration can recompute deliberately, rather than
 * every fingerprint silently changing and every trend line resetting.
 */
export const FINGERPRINT_VERSION = 'v1';
export const SIGNATURE_VERSION = 'v1';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface FingerprintInput {
  projectId: string;
  filePath: string;
  fullTitle: string;
  params?: Record<string, unknown>;
}

/**
 * The stable identity of a test across runs (ADR-007).
 *
 * Scoped by project so two projects cannot collide. Parameters are canonical
 * JSON, so a parameterised test keeps one identity per parameter set and key
 * ordering from the runner does not matter.
 */
export function testCaseFingerprint(input: FingerprintInput): string {
  const parts = [
    FINGERPRINT_VERSION,
    input.projectId,
    normalizeFilePath(input.filePath),
    input.fullTitle.trim(),
    canonicalJson(input.params ?? {}),
  ];
  return sha256Hex(parts.join(SEP));
}

/**
 * The clustering key for failures. Two results share a signature when they are
 * the same error type, the same normalized message and the same leading
 * application stack frames — which is what lets "12 tests failed with the same
 * timeout on /checkout" be a single triage decision.
 */
export function errorSignatureHash(parts: ErrorSignatureParts, projectId: string): string {
  return sha256Hex(
    [
      SIGNATURE_VERSION,
      projectId,
      parts.errorType,
      parts.normalizedMessage,
      parts.normalizedStackHead,
    ].join(SEP),
  );
}

export interface ErrorSignature extends ErrorSignatureParts {
  hash: string;
}

export function buildErrorSignature(
  projectId: string,
  input: { errorType?: string | null; message?: string | null; stack?: string | null },
): ErrorSignature {
  const parts = errorSignatureParts(input);
  return { ...parts, hash: errorSignatureHash(parts, projectId) };
}

/**
 * Configuration identity, so the same browser/os/locale combination is one row
 * reused across runs. Without it, "which feature × locale × browser combos were
 * never run" has nothing stable to compare against.
 */
export function configurationFingerprint(
  projectId: string,
  config: {
    browser?: string | null;
    browserVersion?: string | null;
    device?: string | null;
    os?: string | null;
    osVersion?: string | null;
    viewport?: string | null;
    locale?: string | null;
    dimensions?: Record<string, string>;
  },
): string {
  return sha256Hex(
    [
      'v1',
      projectId,
      canonicalJson({
        browser: config.browser ?? null,
        browserVersion: config.browserVersion ?? null,
        device: config.device ?? null,
        os: config.os ?? null,
        osVersion: config.osVersion ?? null,
        viewport: config.viewport ?? null,
        locale: config.locale ?? null,
        dimensions: config.dimensions ?? {},
      }),
    ].join(SEP),
  );
}

/** API tokens are stored hashed. The plaintext is shown once and never again. */
export function hashApiToken(token: string): string {
  return sha256Hex(token);
}

/**
 * uuid v7: 48 bits of big-endian milliseconds, then randomness.
 *
 * The database generates these by default (`uuid_generate_v7()`), but rows the
 * worker must reference before they are inserted — a test result that steps and
 * attachments point at — need their id up front. Generating the same *shape*
 * here keeps inserts at the right edge of the B-tree, which is the entire
 * reason the schema uses v7 rather than v4.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();

  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
