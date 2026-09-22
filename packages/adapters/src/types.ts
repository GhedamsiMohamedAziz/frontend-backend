import type { ConfigurationInput, IngestEvent, TestIdentity } from '@eyesonbug/shared';

/**
 * What every adapter produces.
 *
 * Deliberately two parts. `events` is the finished ingestion payload, but an
 * attachment cannot become an event until its bytes are in object storage and
 * we know the key and digest. So adapters hand back the *local* files they
 * found, and the reporter turns them into `attachment.added` events once the
 * uploads succeed. Parsing therefore stays a pure function of the report file,
 * with no network and no filesystem reads, which is what makes it testable.
 */
export interface ParsedReport {
  events: IngestEvent[];
  attachments: PendingAttachment[];
  summary: ParsedSummary;
}

export interface PendingAttachment {
  /** Correlates back to the `test.finished` event this belongs to. */
  resultRef: string;
  kind: 'screenshot' | 'video' | 'trace' | 'log' | 'har';
  contentType: string;
  /** Absolute or report-relative path on the CI machine. */
  localPath: string;
  name: string;
}

export interface ParsedSummary {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  configurations: number;
}

export interface AdapterContext {
  /**
   * Repo root, used to make file paths relative so a test keeps one identity
   * regardless of where CI checked the repository out.
   */
  rootDir?: string;
}

export interface Adapter {
  readonly name: string;
  /** Cheap check so `eyesonbug upload` can auto-detect the report format. */
  detect(raw: unknown): boolean;
  parse(raw: unknown, context?: AdapterContext): ParsedReport;
}

export type { ConfigurationInput, TestIdentity };
