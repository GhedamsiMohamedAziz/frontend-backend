/**
 * Pure, isomorphic normalization used to build stable identities.
 *
 * Two identities depend on everything in this file:
 *   - the TestCase fingerprint, which must survive reruns, different CI
 *     working directories and different machines;
 *   - the error signature, which must collapse "the same failure" across
 *     tests, configurations and runs so twelve failures are one decision.
 *
 * Nothing here touches crypto or the filesystem, so it is fully unit-testable
 * and safe to ship to the browser.
 */

/* eslint-disable no-control-regex */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
/* eslint-enable no-control-regex */

/**
 * Remove terminal colour codes.
 *
 * Runners colour their output for a terminal, and that markup travels into the
 * report verbatim. It is meaningless everywhere else — a web page renders it as
 * literal escape sequences — so it is stripped before storage, not just before
 * hashing.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const HEX_ADDRESS = /\b0x[0-9a-f]{4,}\b/gi;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?)\b/gi;
const PORT = /:\d{4,5}\b/g;
const LINE_COL = /:\d+:\d+\b/g;
const LONG_NUMBER = /\b\d{4,}\b/g;
const ABSOLUTE_PATH = /(?:[a-zA-Z]:)?(?:\/[\w.@+-]+){2,}\/?/g;
const WHITESPACE = /\s+/g;

/** Stack frames that belong to the runner or the runtime, not to the product. */
const VENDOR_FRAME =
  /(node_modules|node:internal|internal\/process|\(native\)|<anonymous>|playwright-core|@playwright|webdriverio|cypress\/runner|__vitest|jest-circus)/;

const FRAME_LINE = /^\s*at\s+/;

/**
 * Normalize a test file path so the same test in the same repository produces
 * the same fingerprint regardless of where CI checked it out.
 *
 * The reporter is expected to send repo-relative paths; this is the safety net
 * for the cases where it cannot (absolute paths from a runner, Windows agents).
 */
export function normalizeFilePath(filePath: string): string {
  let p = filePath.trim().replace(/\\/g, '/');
  p = p.replace(WINDOWS_DRIVE, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\.\//, '');
  p = p.replace(/^\//, '');
  return p;
}

/**
 * Canonical JSON: object keys sorted at every depth, so two parameter objects
 * that differ only in key order hash identically. `undefined` members are
 * dropped rather than serialized, matching JSON semantics.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) continue;
    out[key] = sortDeep(member);
  }
  return out;
}

/**
 * Markers where a runner stops describing the failure and starts quoting the
 * source and the call log.
 */
const NOISE_MARKERS = [
  /^\s*Call log:/im,
  /^\s*\d+\s*\|/m, // code frame: "  34 | await expect(...)"
  /^\s*>\s*\d+\s*\|/m, // code frame pointer
  /^\s*at\s+\S+/m, // stack frames embedded in the message
];

/**
 * Keep only the part of the message that describes *what* failed.
 *
 * Playwright appends a call log and a snippet of the source around the failing
 * line. Including that in the signature is actively harmful: adding an import
 * at the top of the file shifts every line number in the snippet, the hash
 * changes, and one cluster silently becomes two — which is the exact failure
 * that error signatures exist to prevent.
 */
function trimToAssertion(message: string): string {
  let cut = message.length;
  for (const marker of NOISE_MARKERS) {
    const match = marker.exec(message);
    if (match?.index !== undefined && match.index < cut) cut = match.index;
  }
  const trimmed = message.slice(0, cut).trim();
  // If a message is *only* a stack, there is nothing else to cluster on.
  return trimmed.length > 0 ? trimmed : message;
}

/**
 * Strip the parts of an error message that vary between two occurrences of the
 * same underlying failure: timestamps, ids, addresses, ports, durations, long
 * numbers and absolute paths.
 *
 * Small integers are deliberately preserved. "expected 3, received 5" and
 * "expected 4, received 6" are usually different bugs, and collapsing them
 * would merge clusters a human would want kept apart.
 */
export function normalizeErrorMessage(message: string): string {
  return trimToAssertion(message)
    .replace(ANSI, '')
    .replace(ISO_TIMESTAMP, '<ts>')
    .replace(UUID, '<uuid>')
    .replace(HEX_ADDRESS, '<addr>')
    .replace(DURATION, '<duration>')
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(PORT, ':<port>')
    .replace(LONG_NUMBER, '<num>')
    .replace(WHITESPACE, ' ')
    .trim()
    .slice(0, 2000);
}

/**
 * Reduce a stack trace to the frames that identify *where in the product* the
 * failure happened: runner and runtime frames dropped, positions removed,
 * paths normalized.
 *
 * @param limit how many leading application frames to keep. Five is enough to
 *   separate distinct call paths without making an unrelated deeper difference
 *   split one cluster into two.
 */
export function normalizeStackFrames(stack: string | null | undefined, limit = 5): string[] {
  if (!stack) return [];
  return stack
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => FRAME_LINE.test(line))
    .filter((line) => !VENDOR_FRAME.test(line))
    .map((line) =>
      line
        .trim()
        .replace(LINE_COL, '')
        .replace(/\\/g, '/')
        .replace(ABSOLUTE_PATH, '<path>')
        .replace(WHITESPACE, ' '),
    )
    .slice(0, limit);
}

export function normalizeStack(stack: string | null | undefined, limit = 5): string {
  return normalizeStackFrames(stack, limit).join('\n');
}

/**
 * The error type as reported ("TimeoutError", "AssertionError"). Falls back to
 * a leading `Name:` prefix in the message when the runner did not supply one.
 */
export function deriveErrorType(
  errorType: string | null | undefined,
  message: string | null | undefined,
): string {
  if (errorType && errorType.trim()) return errorType.trim();
  const match = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\s*:/.exec((message ?? '').trim());
  return match?.[1] ?? 'Error';
}

/**
 * The three components that make up an error signature, kept separate so the
 * clustering key and its human-readable explanation come from the same source.
 */
export interface ErrorSignatureParts {
  errorType: string;
  normalizedMessage: string;
  normalizedStackHead: string;
}

export function errorSignatureParts(input: {
  errorType?: string | null;
  message?: string | null;
  stack?: string | null;
}): ErrorSignatureParts {
  return {
    errorType: deriveErrorType(input.errorType, input.message),
    normalizedMessage: normalizeErrorMessage(input.message ?? ''),
    normalizedStackHead: normalizeStack(input.stack),
  };
}
