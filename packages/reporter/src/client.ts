import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IngestEvent } from '@eyesonbug/shared';
import type { PendingAttachment } from '@eyesonbug/adapters';
import type { ReporterConfig } from './config';

export interface OpenedRun {
  runId: string;
  number: number;
  url: string;
}

export interface UploadTarget {
  resultRef: string;
  sha256: string;
  s3Key: string;
  uploadUrl: string;
}

export interface RunStatus {
  status: string;
  processed: boolean;
  totals: Record<string, number>;
}

export class IngestClient {
  constructor(private readonly config: ReporterConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string },
  ): Promise<T> {
    const { idempotencyKey, ...rest } = init;
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...rest,
      headers: {
        // Only declare a JSON body when there is one. Fastify rejects a request
        // that announces `application/json` and then sends nothing, which is
        // exactly what a bodyless POST like `complete` would do.
        ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${this.config.token}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(rest.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
        detail = parsed.error?.message ?? text;
      } catch {
        // Not JSON — a proxy error page, say. The raw body is the best we have.
      }
      throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`);
    }

    return (text ? JSON.parse(text) : undefined) as T;
  }

  openRun(): Promise<OpenedRun> {
    const c = this.config;
    return this.request<OpenedRun>('/v1/ingest/runs', {
      method: 'POST',
      idempotencyKey: c.idempotencyKey,
      body: JSON.stringify({
        branch: c.branch,
        commitSha: c.commitSha,
        commitMessage: c.commitMessage,
        commitAuthor: c.commitAuthor,
        buildVersion: c.buildVersion,
        environment: c.environment,
        trigger: c.trigger,
        githubWorkflowRunId: c.githubWorkflowRunId,
        githubWorkflowName: c.githubWorkflowName,
        githubRunAttempt: c.githubRunAttempt,
      }),
    });
  }

  /**
   * Ask for presigned PUT targets, then upload straight to object storage.
   *
   * The bytes never pass through the API: a run can carry hundreds of megabytes
   * of video and traces, and proxying that would make artifact upload the
   * dominant load on a service that otherwise moves small JSON.
   */
  async uploadAttachments(runId: string, pending: PendingAttachment[]): Promise<IngestEvent[]> {
    if (pending.length === 0) return [];

    const described = [];
    for (const attachment of pending) {
      try {
        const stats = statSync(attachment.localPath);
        described.push({
          ...attachment,
          sizeBytes: stats.size,
          sha256: await sha256File(attachment.localPath),
        });
      } catch {
        // Playwright can list an attachment whose file was cleaned up between
        // the run and the upload. Skipping one artifact is much better than
        // failing the whole ingestion over it.
        process.stderr.write(`  ! skipping missing attachment ${attachment.localPath}\n`);
      }
    }

    if (described.length === 0) return [];

    const { uploads } = await this.request<{ uploads: UploadTarget[] }>(
      `/v1/ingest/runs/${runId}/attachments`,
      {
        method: 'POST',
        body: JSON.stringify({
          attachments: described.map((a) => ({
            resultRef: a.resultRef,
            kind: a.kind,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            sha256: a.sha256,
            name: a.name,
          })),
        }),
      },
    );

    const byKey = new Map(
      uploads.map((upload) => [`${upload.resultRef}:${upload.sha256}`, upload]),
    );
    const events: IngestEvent[] = [];

    for (const attachment of described) {
      const target = byKey.get(`${attachment.resultRef}:${attachment.sha256}`);
      if (!target) continue;

      const body = await readFile(attachment.localPath);
      const put = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': attachment.contentType },
        body,
      });
      if (!put.ok) {
        throw new Error(`Uploading ${attachment.name} failed (${put.status} ${put.statusText})`);
      }

      events.push({
        eventId: randomUUID(),
        at: new Date(),
        type: 'attachment.added',
        resultRef: attachment.resultRef,
        kind: attachment.kind,
        s3Key: target.s3Key,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
      });
    }

    return events;
  }

  /** Events go up in batches; one request per test would not survive 20k results. */
  async sendEvents(
    runId: string,
    events: IngestEvent[],
    batchSize = 500,
  ): Promise<{ accepted: number; runStatus: string }> {
    let accepted = 0;
    let runStatus = 'running';
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      // No request-level idempotency key: batches are not stable units. The
      // streaming reporter sends a different slice every second, and a replayed
      // batch is deduplicated per *event* — each carries a client-generated
      // `eventId` that the server stores as its unique key.
      const result = await this.request<{ accepted: number; runStatus: string }>(
        `/v1/ingest/runs/${runId}/events`,
        { method: 'POST', body: JSON.stringify({ events: batch }) },
      );
      accepted += result.accepted;
      runStatus = result.runStatus;
    }
    return { accepted, runStatus };
  }

  complete(runId: string): Promise<{ queued: boolean }> {
    return this.request<{ queued: boolean }>(`/v1/ingest/runs/${runId}/complete`, {
      method: 'POST',
      idempotencyKey: `${this.config.idempotencyKey}:complete`,
    });
  }

  status(runId: string): Promise<RunStatus> {
    return this.request<RunStatus>(`/v1/ingest/runs/${runId}`, { method: 'GET' });
  }

  /**
   * Ingestion is queued, so a run is not readable the instant it is uploaded.
   * Waiting here means a CI job's log ends with the real outcome rather than
   * "uploaded, check later".
   */
  async waitForProcessing(runId: string, timeoutMs: number): Promise<RunStatus> {
    const deadline = Date.now() + timeoutMs;
    let delay = 250;
    for (;;) {
      const status = await this.status(runId);
      if (status.processed) return status;
      if (Date.now() > deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 3_000);
    }
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
