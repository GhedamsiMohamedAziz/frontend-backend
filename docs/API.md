# EyesOnBug — API Surface

> Status: **accepted**. Routes marked (M0) are implemented; the rest are the
> agreed contract for later milestones.
> All routes under `/v1`. Zod-validated in and out; OpenAPI generated from the
> same schemas. Responses are keyset-paginated (`?cursor=&limit=`), never OFFSET.

Path convention: `/v1/o/:orgSlug/p/:projectSlug/...`

Org and project live in the path rather than in a header so that **every URL is
shareable** — which is a stated UX requirement, and it means a pasted API URL
is unambiguous about which tenant it refers to.

Legend: 🔓 public · 👤 session · 🔑 API token · ⚙️ webhook signature

**Implemented (M0):** `/health`, `/ready`, `/v1/openapi.json`, the whole
`/v1/auth` group, `/v1/me`, `/v1/orgs`, `/v1/o/:org`, `/v1/o/:org/members`,
`/v1/o/:org/projects`, `/v1/o/:org/p/:project` (GET, PATCH), and that project's
`members`, `environments` and `tokens`.

**Implemented (M1 ingestion):** the whole `/v1/ingest` group — batch _and_
streaming — plus `runs`, `runs/:runId`, `runs/:runId/failures`,
`runs/:runId/results`, `results/:resultId` and `attachments/:attachmentId`.

**Implemented (M2 live):** `runs/:runId/stream` (SSE, with `Last-Event-ID`
resume) and `runs/:runId/cancel`. Ingested batches are processed as they
arrive rather than only at `complete`.

**Implemented (M3, in progress):** `/v1/o/:org/github/*` (install URL, link /
unlink installation, repos, workflows, parsed `workflow_dispatch` inputs) and
`/v1/webhooks/github` (`installation`, `installation_repositories`,
`workflow_run`).

**Not yet implemented:** workflow configs, dispatch, schedules, quality gates,
rerun and hard cancellation (rest of M3); metrics endpoints (M4); triage (M5).
Everything else below is the agreed contract for those milestones.

---

## Auth & identity

```
🔓 GET    /v1/auth/github                 start OAuth
🔓 GET    /v1/auth/github/callback        exchange code, set session cookie
👤 POST   /v1/auth/logout
👤 GET    /v1/me                          user, orgs, project roles, prefs
👤 PATCH  /v1/me                          name, locale, theme
```

## Organizations & projects

```
👤 GET    /v1/orgs                                    orgs I belong to
👤 POST   /v1/orgs                                    create org
👤 GET    /v1/o/:org                                  org detail
👤 PATCH  /v1/o/:org                                  admin
👤 GET    /v1/o/:org/members                          list
👤 POST   /v1/o/:org/members                          invite            admin
👤 PATCH  /v1/o/:org/members/:userId                  change role       admin
👤 DELETE /v1/o/:org/members/:userId                  remove            admin
👤 GET    /v1/o/:org/teams                            CRUD teams
👤 GET    /v1/o/:org/projects
👤 POST   /v1/o/:org/projects                                           admin
👤 GET    /v1/o/:org/p/:project
👤 PATCH  /v1/o/:org/p/:project                                         admin
👤 GET    /v1/o/:org/p/:project/members  + POST/PATCH/DELETE            admin
👤 GET    /v1/o/:org/p/:project/environments + CRUD                     maintainer
👤 GET    /v1/o/:org/p/:project/tokens                list (prefix only) admin
👤 POST   /v1/o/:org/p/:project/tokens                shown once         admin
👤 DELETE /v1/o/:org/p/:project/tokens/:id            revoke             admin
👤 GET    /v1/o/:org/audit-log                                           admin
```

## Ingestion (the CI-facing surface)

```
🔑 POST   /v1/ingest/runs                      open a run  → { runId, uploadPolicy }
🔑 PATCH  /v1/ingest/runs/:runId               update status/totals/finish
🔑 POST   /v1/ingest/runs/:runId/events        batched event envelope  → 202
🔑 POST   /v1/ingest/runs/:runId/attachments   request presigned PUT(s)
🔑 POST   /v1/ingest/runs/:runId/archive       batch upload: presign a results archive
🔑 POST   /v1/ingest/runs/:runId/complete      seal the run, trigger rollups + gate
```

**Idempotency.** Every request carries `Idempotency-Key`; every event in an
envelope carries its own `eventId`. Both are unique per project. A retried CI
step replays byte-identical requests and produces zero duplicate rows —
`ON CONFLICT DO NOTHING` on `ingest_event`, and the 2xx response is replayed
from the recorded outcome.

**Event kinds** (discriminated union in `packages/shared`):
`run.started · run.finished · config.started · config.finished · test.started ·
test.finished · step.started · step.finished · attachment.added · log.appended`

Adapters for Playwright JSON, JUnit XML, Cucumber JSON, Allure, WDIO and Cypress
normalize to this same union, so streaming and batch share one write path.

## Runs, results, live view

```
👤 GET    /v1/o/:org/p/:project/runs                    filters ↓, keyset paging
👤 GET    /v1/o/:org/p/:project/runs/:runId
👤 GET    /v1/o/:org/p/:project/runs/:runId/stream      SSE, Last-Event-ID
👤 GET    /v1/o/:org/p/:project/runs/:runId/configurations
👤 GET    /v1/o/:org/p/:project/runs/:runId/tree        lazy per-node report tree
👤 GET    /v1/o/:org/p/:project/runs/:runId/matrix      tests × configs heatmap
👤 GET    /v1/o/:org/p/:project/runs/:runId/failures    grouped by signature
👤 GET    /v1/o/:org/p/:project/runs/:runId/compare/:otherRunId
👤 POST   /v1/o/:org/p/:project/runs/:runId/cancel                      qa
👤 POST   /v1/o/:org/p/:project/runs/:runId/rerun       { kind: failed|all }  qa
👤 GET    /v1/o/:org/p/:project/results/:resultId       steps, error, retries
👤 GET    /v1/o/:org/p/:project/results/:resultId/attachments   signed GETs
👤 GET    /v1/o/:org/p/:project/results/:resultId/history       last 30
```

`runs` filter params, shared verbatim with History, Report and Metrics:
`branch · commit · environment · status · trigger · feature · locale · browser ·
device · os · tag · owner · build · from · to · q`

One parser in `packages/shared` serves the URL bar, the API and the CSV export —
so a shared link, an API call and an export always mean the same thing.

## Test cases

```
👤 GET    /v1/o/:org/p/:project/tests                  search, filter, sort
👤 GET    /v1/o/:org/p/:project/tests/:testId          stats, owner, linked bugs
👤 GET    /v1/o/:org/p/:project/tests/:testId/history  across runs × configs
👤 POST   /v1/o/:org/p/:project/tests/:testId/quarantine    { reason }     qa
👤 DELETE /v1/o/:org/p/:project/tests/:testId/quarantine                   qa
👤 POST   /v1/o/:org/p/:project/tests/:testId/aliases  adopt a fingerprint qa
👤 PATCH  /v1/o/:org/p/:project/tests/:testId          owner team, feature maintainer
👤 GET    /v1/o/:org/p/:project/features               + owners
```

## Metrics

```
👤 GET    /v1/o/:org/p/:project/metrics/pass-rate      ?groupBy=day|feature|config|locale
👤 GET    /v1/o/:org/p/:project/metrics/flakiness      ranked
👤 GET    /v1/o/:org/p/:project/metrics/durations      slowest + regressions
👤 GET    /v1/o/:org/p/:project/metrics/failures       by feature|category|env
👤 GET    /v1/o/:org/p/:project/metrics/triage         MTTT, MTTF, backlog
👤 GET    /v1/o/:org/p/:project/metrics/coverage       unrun matrix combos
👤 GET    /v1/o/:org/p/:project/metrics/export.csv     any of the above
👤 GET    /v1/o/:org/p/:project/views  + CRUD          saved named views
```

All read from rollup tables. Every endpoint accepts the same filter params as
`runs`.

## Triage & bug reports

```
👤 GET    /v1/o/:org/p/:project/triage/inbox           untriaged, by signature
👤 GET    /v1/o/:org/p/:project/signatures/:sigId      cluster detail
👤 POST   /v1/o/:org/p/:project/triage                 one decision        qa
👤 POST   /v1/o/:org/p/:project/triage/bulk            whole cluster       qa
👤 PATCH  /v1/o/:org/p/:project/triage/:id             recategorize/resolve qa
👤 GET    /v1/o/:org/p/:project/known-issues  + CRUD                       qa
👤 POST   /v1/o/:org/p/:project/bug-reports/preview    prefilled issue draft
👤 POST   /v1/o/:org/p/:project/bug-reports            create GitHub issue qa
👤 GET    /v1/o/:org/p/:project/comments?subject=...  + POST/PATCH/DELETE
```

`POST /triage` writes the decision **and** its frozen `triage_context` snapshot
in one transaction. If the snapshot cannot be built, the decision is rejected —
an unlabelled decision is worse than no decision for M6.

## GitHub back office

```
👤 GET    /v1/o/:org/github/install-url                                 admin
👤 GET    /v1/o/:org/github/installation                                admin
👤 DELETE /v1/o/:org/github/installation                                admin
👤 GET    /v1/o/:org/github/repos                       installed repos admin
👤 GET    /v1/o/:org/github/repos/:owner/:repo/workflows                admin
👤 GET    /v1/o/:org/github/repos/:owner/:repo/workflows/:id/inputs
              parsed workflow_dispatch inputs → generates the launcher form
👤 GET    /v1/o/:org/p/:project/workflow-configs  + CRUD      maintainer
👤 POST   /v1/o/:org/p/:project/workflow-configs/:id/dispatch  trigger  qa
👤 GET    /v1/o/:org/p/:project/schedules  + CRUD             maintainer
👤 GET    /v1/o/:org/p/:project/quality-gates  + CRUD         maintainer
👤 GET    /v1/o/:org/p/:project/notification-rules  + CRUD    maintainer
👤 GET    /v1/o/:org/p/:project/retention  + PATCH            admin
⚙️ POST   /v1/webhooks/github                  workflow_run, workflow_job,
                                               check_run, installation
```

Verified against the official GitHub docs on 2026-09-22: `workflow_dispatch`
accepts **max 25 inputs** and only `branch`/`tag` refs, and returns **`200`
with `workflow_run_id`**, so a dispatch creates its Run row directly. The
GitHub App needs `actions:write`, `checks:write`, `contents:read`,
`issues:write`, `metadata:read`. Webhook deliveries are verified with
`X-Hub-Signature-256` over the raw body.

## Ops

```
🔓 GET    /health          liveness
🔓 GET    /ready           pg + redis + s3 reachable
🔓 GET    /v1/openapi.json
```

---

## Realtime event envelope

```jsonc
{
  "seq": 4711,
  "runId": "…",
  "type": "test.finished",
  "at": "2026-09-22T10:31:02.441Z",
  "data": {
    "testCaseId": "…",
    "configurationId": "…",
    "status": "failed",
    "durationMs": 3412,
    "errorPreview": "TimeoutError: locator.click…",
    "screenshotKey": "…",
  },
}
```

`seq` is per-run and monotonic. The client tracks the highest `seq` it has
applied; SSE reconnect sends `Last-Event-ID`, the server replays the gap from a
Redis stream (capped at 10k events / 1h), and on a gap too large it tells the
client to refetch instead of silently dropping events.
