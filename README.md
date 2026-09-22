# EyesOnBug

Acceptance and E2E test orchestration, reporting and triage. Tests run in GitHub
Actions; EyesOnBug owns everything around them — live runs, searchable history,
rich reports, metrics, and the triage decisions that turn a wall of red into a
short list of things to fix.

**Status: M0–M3.** A real Playwright suite in `examples/demo-e2e` runs and
streams its results as they happen: the run is watchable live — progress, ETA,
per-configuration lanes, failures appearing with a screenshot the moment they
occur — and becomes a full report when it ends, with failures grouped by cause
and every artifact attached. With the GitHub App installed, runs are launched
from here — by hand from a generated form or on a schedule — re-run, cancelled
for real, and gated: a quality gate becomes a commit check GitHub can require.
The remaining adapters, metrics and triage follow in M4–M5.

---

## Setup

You need Docker, Node 22+ and pnpm 10.

```bash
git clone <this repo> && cd EyesOnBug
cp .env.example .env
pnpm setup          # install, start containers, build, migrate, seed
pnpm dev            # api :4000 · web :3000 · worker :4100
```

`pnpm setup` is the whole thing. It installs dependencies, brings up Postgres,
Redis and MinIO, builds the workspace, applies migrations and loads demo data.

Then open **http://localhost:3000** and sign in with one of the seeded accounts:

| Account                  | Sees                                          |
| ------------------------ | --------------------------------------------- |
| `demo@eyesonbug.dev`     | Org owner — admin on every Acme project       |
| `dev@eyesonbug.dev`      | Maintainer — can configure runs, not members  |
| `qa@eyesonbug.dev`       | QA — can triage and rerun, cannot mint tokens |
| `viewer@eyesonbug.dev`   | Read-only                                     |
| `outsider@northwind.dev` | A different tenant — sees none of Acme's data |

Sign-in uses GitHub OAuth in real deployments. The account picker above is a
development shortcut, gated on `NODE_ENV=development` **and** an explicit
`ALLOW_DEV_LOGIN=true`, and it only ever matches a user that already exists.
To use real OAuth instead, register a GitHub OAuth app with the callback
`http://localhost:4000/v1/auth/github/callback` and set
`GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.

### Connecting GitHub (M3)

Launching, re-running, cancelling and gating runs go through a GitHub App
(ADR-011). Create one at **Settings → Developer settings → GitHub Apps** with:

| Setting        | Value                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Webhook URL    | `https://<your api>/v1/webhooks/github` (locally, a tunnel to `:4000`)                           |
| Webhook secret | anything; copy it to `GITHUB_WEBHOOK_SECRET`                                                     |
| Setup URL      | `https://<your web>/github/setup`, with "Redirect on update" ticked                              |
| Permissions    | Actions **write**, Checks **write**, Contents **read**, Metadata **read**, Issues **write** (M5) |
| Subscribe to   | Installation, Installation repositories, Workflow run                                            |

Then set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (the PEM,
or the PEM base64-encoded on one line) and `GITHUB_WEBHOOK_SECRET`, restart,
and use **Org settings → GitHub → Install** while signed in with GitHub. Only
the GitHub user who installs the App can link it to an organization
(ADR-024), so the dev-login accounts cannot complete this step.

Without these variables everything else works and the GitHub routes answer
`503 github_not_configured`.

### Where things are

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| Web           | http://localhost:3000                                                   |
| API           | http://localhost:4000 · docs at `/v1/docs` · spec at `/v1/openapi.json` |
| Worker health | http://localhost:4100/health                                            |
| MinIO console | http://localhost:9001 (`eyesonbug` / `eyesonbug-dev-secret`)            |
| Postgres      | `localhost:5432` (`eyesonbug` / `eyesonbug`)                            |

---

## Layout

```
apps/
  web/        Next.js App Router · Tailwind · TanStack Query · light+dark · en/fr
  api/        NestJS on Fastify · session auth · RBAC guard · OpenAPI
  worker/     BullMQ · scheduled maintenance (partitions, sessions, retention)
packages/
  shared/     Zod schemas, domain enums, filter vocabulary, RBAC table,
              fingerprinting and error-signature normalization
  db/         Drizzle schema, migrations, RLS policies, seed
  adapters/   Report parsers (Playwright JSON today) → one event contract
  reporter/   @eyesonbug/reporter — the `eyesonbug` CLI your CI runs
examples/
  demo-e2e/   A standalone Playwright repo that reports to EyesOnBug
docs/
  ARCHITECTURE.md   system diagram, tenancy, realtime, scale strategy
  SCHEMA.md         the data model and why it is shaped this way
  API.md            route list and the ingestion contract
  DECISIONS.md      ADRs
  SPEC.md           the original brief
```

## Commands

```bash
pnpm dev            # everything, in watch mode
pnpm build          # build all packages and apps
pnpm test           # unit + integration (needs the containers running)
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit everywhere
pnpm format         # prettier

pnpm db:generate    # generate a migration from the Drizzle schema
pnpm db:migrate     # apply migrations
pnpm db:seed        # reload demo data
pnpm db:reset       # drop and recreate the schema (local only)

pnpm infra:up       # docker compose up -d
pnpm infra:nuke     # down -v — deletes the volumes too
```

---

## Sending your own test results

Your tests live in your repository and run in your CI. EyesOnBug only receives
the results. Two bits of wiring:

```ts
// playwright.config.ts
reporter: [
  ['list'],
  ['json', { outputFile: 'playwright-report.json' }],
  // Streaming: results arrive as they happen, so the run is watchable live.
  // Disables itself with a warning when EYESONBUG_TOKEN is not set.
  ['@eyesonbug/reporter/playwright', { environment: 'staging' }],
],

// and, per project, the dimensions the JSON reporter does not serialize
metadata: { browser: 'chromium', locale: 'fr-FR' },
```

Streaming and the batch CLI produce identical test fingerprints, so you can use
either or both without splitting any test's history. Streaming makes a long
suite watchable; the batch upload is the simpler thing and still the right
choice for a short one.

```yaml
# .github/workflows/e2e.yml
- run: npx playwright test
  continue-on-error: true # report a red suite, do not hide it
- run: npx eyesonbug upload
  if: always()
  env:
    EYESONBUG_URL: ${{ vars.EYESONBUG_URL }}
    EYESONBUG_TOKEN: ${{ secrets.EYESONBUG_TOKEN }}
```

Branch, commit, trigger and the CI run id come from the standard `GITHUB_*`
variables, so the token is usually the only thing to configure. `examples/demo-e2e`
is a complete working example — run `npm test && npx eyesonbug upload` in it.

The upload is idempotent: it keys off the GitHub run id and attempt, so
re-running a failed job updates that run rather than creating a phantom
duplicate.

## Two things worth knowing before you read the code

**Tenant isolation is enforced by Postgres, not by discipline.** The API and
worker connect as a role that is not the table owner and has `NOBYPASSRLS`.
Every query runs inside a transaction that sets `app.current_org_id`, and every
tenant table has a row-level security policy keyed on it. A query that forgets
its `WHERE organization_id = ...` returns zero rows rather than another
customer's data. `packages/db/test/isolation.test.ts` asserts this against a
real database, including that the policy coverage is total and that pooled
connections never leak context between tenants.

Exactly two things bypass this: migrations, and the identity bootstrap at login
(finding or creating a user before any organization is known). Both use a
separate connection URL and a separate class — `SystemDb` — so "what can bypass
isolation?" is a question you answer by grepping for one symbol.

**Triage decisions freeze their own context.** A triage decision is only usable
as a training label if the model can later see exactly what the human saw.
Re-deriving that at training time would be subtly wrong: the test gets renamed,
the screenshot expires under retention, the stack normalizer improves. So a
decision and a versioned snapshot of its inputs are written in one transaction,
and the decision is rejected if the snapshot cannot be built. M6's AI triage is
design-only, but its dataset starts accumulating the day M5 ships.

See `docs/DECISIONS.md` for the rest, including why matrix runs are one `Run`
with many configurations, and why `test_result` is partitioned from day one.

---

## What M0 actually delivers

- pnpm + Turborepo monorepo, strict TypeScript, no `any`, Zod on every boundary
- `docker compose up` gives Postgres 16, Redis 7 and MinIO with the artifact
  bucket already created
- 41 tables, uuid v7 keys, RLS on every tenant table, `test_result` range-
  partitioned monthly with a helper that provisions future months
- GitHub OAuth with hashed server-side sessions; RBAC with four project roles
  enforced in a server-side guard and shared with the UI as one capability table
- API tokens stored as hashes, shown once
- Demo data: 2 organizations, 4 projects, 41 test cases, 66 runs, ~8,700
  results, deliberate flakes, a dated regression, clustered failures, and
  triage decisions with frozen context
- 72 tests, and CI that runs them against a real Postgres

## Watching a run

While a run is in flight its page shows a live view instead of the report:
progress against an expected total, an ETA, one lane per configuration, and a
failure rail where each failure appears with its error and a screenshot within a
second or two of happening. It becomes the full report the moment the run ends.

The transport is Server-Sent Events over the same origin, resumable with
`Last-Event-ID` (ADR-018). **Cancel** marks the run cancelled and the reporter
stops on its next flush; stopping the GitHub Actions job itself needs the GitHub
App, so that — and Rerun — arrive in M3 (ADR-021).

## What is built

- `@eyesonbug/adapters` — Playwright JSON → one normalized event contract,
  tested against a report produced by actually running the demo suite
- `@eyesonbug/reporter` — the `eyesonbug` CLI: parses, opens a run, uploads
  artifacts straight to S3 via presigned PUTs, posts events in batches, and waits
  for processing so a CI log ends with the real outcome
- Ingestion endpoints authenticated by project token, idempotent per CI attempt,
  returning `202` and deferring the write to the worker
- The worker resolves test identities, assigns error signatures, writes results
  and refreshes rollups
- Run history, run report with failures grouped by error signature, and a test
  detail drawer with the error, a 30-run history strip, screenshots and artifacts
- A streaming Playwright reporter, batches processed as they land, and a live
  run view over SSE with progress, ETA, per-configuration lanes and a failure
  rail
- The GitHub back office: an App installed per organization, run templates
  whose launcher form is generated from the workflow's `workflow_dispatch`
  inputs, manual and scheduled dispatch, rerun (all or failed jobs), hard
  cancel, and quality gates reported as check runs on the commit. Webhooks are
  verified over the raw body and folded idempotently by GitHub's own ids

**Not yet built:** the remaining adapters (JUnit, Cucumber, Allure, WDIO,
Cypress), metrics screens (M4), the triage inbox, notifications and bug
creation (M5).

**Known gap in the demo data:** the _seeded_ runs include attachment rows whose
S3 objects do not exist. Runs uploaded by the reporter have real artifacts.
