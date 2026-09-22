import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseReport } from '@eyesonbug/adapters';
import { IngestClient } from './client';
import type { ReporterConfig } from './config';

export interface UploadResult {
  runId: string;
  number: number;
  url: string;
  eventsSent: number;
  attachmentsUploaded: number;
  status: string;
  processed: boolean;
}

export async function upload(
  config: ReporterConfig,
  log: (message: string) => void = () => {},
): Promise<UploadResult> {
  const reportPath = resolve(process.cwd(), config.reportPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read the test report at ${reportPath}. ` +
        `Add a json reporter to your Playwright config:\n` +
        `  reporter: [['list'], ['json', { outputFile: 'playwright-report.json' }]]\n` +
        `(${(error as Error).message})`,
    );
  }

  const { adapter, report } = parseReport(raw, { rootDir: config.rootDir });
  log(
    `parsed ${adapter.name}: ${report.summary.total} tests across ` +
      `${report.summary.configurations} configuration(s) — ` +
      `${report.summary.passed} passed, ${report.summary.failed} failed, ` +
      `${report.summary.flaky} flaky, ${report.summary.skipped} skipped`,
  );

  const client = new IngestClient(config);

  const run = await client.openRun();
  log(`opened run #${run.number}`);

  const attachmentEvents = await client.uploadAttachments(run.runId, report.attachments);
  if (attachmentEvents.length > 0) log(`uploaded ${attachmentEvents.length} artifact(s)`);

  // Attachment events go last: they reference results, and the worker resolves
  // those references in one pass over the ordered event list.
  const events = [...report.events, ...attachmentEvents];
  const { accepted: eventsSent } = await client.sendEvents(run.runId, events);
  log(`sent ${eventsSent} event(s)`);

  await client.complete(run.runId);

  let status = { status: 'queued', processed: false, totals: {} as Record<string, number> };
  if (config.wait) {
    status = await client.waitForProcessing(run.runId, config.timeoutMs);
    log(
      status.processed ? `run ${status.status}` : 'still processing — results will appear shortly',
    );
  }

  return {
    runId: run.runId,
    number: run.number,
    url: run.url,
    eventsSent,
    attachmentsUploaded: attachmentEvents.length,
    status: status.status,
    processed: status.processed,
  };
}
