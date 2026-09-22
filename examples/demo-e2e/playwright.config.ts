import { defineConfig, devices } from '@playwright/test';

/**
 * Two projects over one suite: the same tests, two locales.
 *
 * That is the smallest configuration matrix that is actually interesting —
 * it produces a failure that exists in one cell and not the other, which is
 * exactly the kind of result a per-run report has to make obvious.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry, so a test that fails then passes is recorded as flaky rather
  // than failing the build. EyesOnBug keeps every attempt.
  retries: 1,
  workers: process.env.CI ? 2 : undefined,

  reporter: [
    // `list` keeps the terminal output readable locally.
    ['list'],
    // The JSON report is what `eyesonbug upload` reads, and what CI archives.
    ['json', { outputFile: 'playwright-report.json' }],
    /*
     * Streaming: results reach EyesOnBug as they happen, so a long suite is
     * watchable while it runs instead of only after it ends. It disables itself
     * with a warning when EYESONBUG_TOKEN is not set, so the suite still runs
     * for anyone who has not configured it — which is why this is conditional
     * only on the token and not on CI.
     *
     * Streaming and the batch CLI produce identical test identities, so you can
     * use either or both without splitting any test's history.
     */
    ...(process.env.EYESONBUG_TOKEN
      ? ([['@eyesonbug/reporter/playwright', { environment: 'staging' }]] as const)
      : []),
  ],

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4310',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-en',
      use: { ...devices['Desktop Chrome'], locale: 'en-US' },
      // Playwright's JSON reporter does not serialize `use`, so a report on its
      // own cannot say which browser or locale a project ran with. `metadata`
      // IS serialized, and EyesOnBug reads these keys to build the run's
      // configuration matrix. Without them you still get one row per project,
      // just without locale as a filterable dimension.
      metadata: { browser: 'chromium', locale: 'en-US', viewport: '1280x720' },
    },
    {
      name: 'chromium-fr',
      use: { ...devices['Desktop Chrome'], locale: 'fr-FR' },
      metadata: { browser: 'chromium', locale: 'fr-FR', viewport: '1280x720' },
    },
  ],

  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:4310',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
