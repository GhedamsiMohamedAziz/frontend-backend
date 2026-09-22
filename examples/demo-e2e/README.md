# Acme Storefront — acceptance tests

A small, self-contained Playwright suite that reports to
[EyesOnBug](../../README.md). It exists to be a realistic example of the repo
you would actually have: tests, a config, a workflow, and one secret.

## What it tests

A tiny storefront served from `app/index.html` by `server.mjs`, started
automatically by Playwright's `webServer`. Nothing reaches the network, so the
only failures this suite produces are the ones it is designed to produce:

| Test                                          | Behaviour                       | Why it is here                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Checkout > shows prices in the local format` | **Fails on `chromium-fr` only** | The app formats every price with a full stop, which is right for en-US and wrong for fr-FR. Identical test, identical commit, one configuration red — only visible if results are stored per configuration. |
| `Shopping cart > updates the quantity`        | **Fails, then passes on retry** | Deterministically flaky, keyed off the attempt number. Both attempts are stored; the result is recorded as flaky rather than failed.                                                                        |
| `Checkout > supports gift wrapping`           | **Skipped**                     | So the report has all four statuses.                                                                                                                                                                        |
| everything else                               | Passes                          |                                                                                                                                                                                                             |

## Running it

```bash
npm install
npx playwright install chromium
npm test                    # 19 passed, 1 failed, 2 flaky, 2 skipped
```

## Sending results to EyesOnBug

```bash
export EYESONBUG_URL=http://localhost:4000
export EYESONBUG_TOKEN=<project ingest token>
npx eyesonbug upload
```

The token comes from **Project → Ingest tokens** in EyesOnBug and is shown once.
Branch, commit, trigger and the CI run id are read from the standard `GITHUB_*`
variables, so in a workflow the token is usually the only thing to configure —
see `.github/workflows/e2e.yml`.

## The two bits of wiring

**1. A JSON reporter.** `eyesonbug upload` reads it.

```ts
reporter: [['list'], ['json', { outputFile: 'playwright-report.json' }]],
```

**2. Project `metadata`.** Playwright's JSON reporter does not serialize a
project's `use` block, so a report on its own cannot say which browser or locale
a project ran with. `metadata` _is_ serialized, and EyesOnBug reads these keys to
build the configuration matrix:

```ts
{
  name: 'chromium-fr',
  use: { ...devices['Desktop Chrome'], locale: 'fr-FR' },
  metadata: { browser: 'chromium', locale: 'fr-FR', viewport: '1280x720' },
}
```

Without it you still get one row per Playwright project — you just lose locale
and browser as filterable dimensions.
