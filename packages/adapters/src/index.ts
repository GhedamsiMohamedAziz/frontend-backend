import type { Adapter, AdapterContext, ParsedReport } from './types';
import { playwrightAdapter } from './playwright';

export * from './types';
export {
  playwrightAdapter,
  // Shared with the streaming reporter, so a test keeps the same identity and
  // the same status mapping whether its results arrive live or as a batch.
  attemptStatus,
  attachmentKind,
  configurationFor,
  deriveFeature,
  platformOs,
} from './playwright';

/**
 * Registered adapters, in detection order.
 *
 * M1 adds JUnit XML, then Cucumber, Allure, WebdriverIO and Cypress. They all
 * normalize to the same `IngestEvent` union, so adding one never touches the
 * API or the worker — which is the point of having this package at all.
 */
export const ADAPTERS: readonly Adapter[] = [playwrightAdapter];

export function detectAdapter(raw: unknown): Adapter | null {
  return ADAPTERS.find((adapter) => adapter.detect(raw)) ?? null;
}

export function parseReport(
  raw: unknown,
  context?: AdapterContext,
): { adapter: Adapter; report: ParsedReport } {
  const adapter = detectAdapter(raw);
  if (!adapter) {
    throw new Error(
      `Unrecognised report format. Supported: ${ADAPTERS.map((a) => a.name).join(', ')}`,
    );
  }
  return { adapter, report: adapter.parse(raw, context) };
}
