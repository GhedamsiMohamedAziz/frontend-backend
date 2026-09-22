# EyesOnBug — Architecture

> Status: **accepted**. M0 is implemented; later sections describe the target
> design for M1–M5 and are built out milestone by milestone.

EyesOnBug is a multi-tenant SaaS that receives acceptance/E2E test results, stores them
durably, and turns them into live views, history, metrics and triage decisions.
It does not run tests. Execution lives in GitHub Actions.

---

## 1. System diagram

```
   ┌──────────────────────── CI (GitHub Actions) ────────────────────────┐
   │  test job                                                            │
   │    └─ @eyesonbug/reporter  ──(1) stream events ─────────┐            │
   │    └─ results archive      ──(2) batch upload ──────────┤            │
   │    └─ artifacts            ──(3) direct PUT ──────┐     │            │
   └───────────────────────────────────────────────────┼─────┼────────────┘
                                                       │     │
                        presigned PUT (no API proxy)   │     │ POST /v1/ingest/*
                                                       ▼     ▼
   ┌─────────────┐                              ┌──────────────────────────┐
   │  S3 / MinIO │◀────── signed GET ───────────│  apps/api   (NestJS)     │
   │  artifacts  │                              │  ── authn: session|token │
   └─────────────┘                              │  ── authz: RBAC guard    │
                                                │  ── org scope: RLS txn   │
                                                │  ── Zod at every edge    │
                                                └────┬──────────┬──────────┘
                                                     │          │
                                       enqueue job   │          │  SSE subscribe
                                                     ▼          ▼
                                            ┌────────────┐  ┌────────────────┐
                                            │   Redis    │  │  Redis pub/sub │
                                            │  BullMQ    │  │  run:<id>      │
                                            └─────┬──────┘  └────────▲───────┘
                                                  │                  │
                                                  ▼                  │ publish
                                        ┌──────────────────────────┐ │
                                        │  apps/worker             │─┘
                                        │  ingest · rollups ·      │
                                        │  github sync · schedules │
                                        │  notifications · reaper  │
                                        └────────────┬─────────────┘
                                                     │
                                                     ▼
                                        ┌──────────────────────────┐
                                        │  PostgreSQL 16           │
                                        │  RLS per organization    │
                                        │  test_result partitioned │
                                        │  rollup tables           │
                                        └──────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────────┐
   │  apps/web (Next.js App Router)                                        │
   │  RSC shell + TanStack Query · SSE client · Cmd+K · URL filter state   │
   └──────────────────────────────────────────────────────────────────────┘

   GitHub App ──webhooks──▶ /v1/webhooks/github ──▶ queue ──▶ worker
              ◀──dispatch/checks── worker (Octokit, installation token)
```

### Why a queue sits between ingest and the database

A 20k-result run streaming per-test events would otherwise be 20k synchronous
writes on the request path. The API validates, assigns an idempotency key, and
returns `202` in single-digit milliseconds; the worker batches inserts (500 rows
per `COPY`-style multi-insert) and publishes to Redis pub/sub for the live view.

The added hop costs ~50ms, well inside the 2s live-latency budget, and it means a
CI job is never slowed down or failed by our database being busy.

### Why artifacts never touch the API

The reporter asks for a presigned `PUT` and uploads a 40MB video straight to S3.
Proxying that through the API would make artifact upload the dominant load on a
service that otherwise handles small JSON. Reads are short-lived signed `GET`s,
so RBAC is enforced at URL-issue time rather than by streaming bytes.

---

## 2. Monorepo layout

```
apps/
  web/            Next.js 15 App Router, React 19, Tailwind, shadcn/ui
  api/            NestJS on the Fastify adapter
  worker/         BullMQ processors (no HTTP surface except /health)
packages/
  shared/         Zod schemas + inferred types + API contract. Isomorphic.
  db/             Drizzle schema, migrations, RLS helpers. Node-only.
  adapters/       Result parsers. Playwright JSON is implemented; junit-xml,
                  cucumber, allure, wdio and cypress follow in M1. Pure
                  functions — no network, no filesystem — so they unit-test
                  against real reports.
  reporter/       @eyesonbug/reporter — npm package + `eyesonbug` CLI used by CI
  config/         eslint / tsconfig / tailwind presets
```

**Why `db` is separate from `shared`:** `shared` is imported by the browser
bundle. Drizzle drags in `pg` and Node built-ins. Merging them would either
bloat the client bundle or force fragile `export` maps. The boundary is:
`shared` = what a contract looks like, `db` = where rows live.

**Why `adapters` is its own package:** both the reporter (streaming, in CI) and
the API (batch archive upload) parse the same formats. Parsers are pure
`(fileContents) => NormalizedResult[]`, so they unit-test without a database.

---

## 3. Multi-tenancy

Shared database, shared schema, `organization_id` on every tenant-owned table.

Three layers of enforcement, because app-level scoping alone is one forgotten
`where` clause away from a cross-tenant leak:

1. **Request scope.** Every authenticated request resolves exactly one
   `organization_id` (from the session's active org, or from the API token).
2. **Transaction scope.** Every query runs inside a transaction that begins with
   `SET LOCAL app.current_org_id = $1`. A repository helper is the only way to
   open a transaction; it cannot be skipped.
3. **Postgres RLS.** Every tenant table carries
   `USING (organization_id = current_setting('app.current_org_id')::uuid)`.
   The application role has no `BYPASSRLS`. A missing `where` clause returns
   zero rows instead of another tenant's data.

Migrations run as a separate owner role that does bypass RLS. The worker sets
the same `SET LOCAL` per job.

---

## 4. Realtime

**Server-Sent Events, not WebSockets.** The live run view is strictly
server→client; cancel and rerun are ordinary `POST`s. SSE is plain HTTP, so it
inherits auth, proxies, and load balancing with no separate upgrade path, and it
reconnects with `Last-Event-ID` for free.

`GET /v1/.../runs/:id/stream` opens an SSE connection. The worker appends each
update to a capped, expiring Redis **stream** (`live:run:<id>`) and publishes an
empty message on a pub/sub **channel** (`live:notify:<id>`). The API holds one
subscriber per process and, when woken, reads the stream from each client's last
id — so ten people watching one run share a single subscription.

The stream id is the SSE `id:`, which makes `Last-Event-ID` resume exact: a
browser that drops for three seconds reconnects and receives precisely what it
missed. Pub/sub alone could not do that, and a blocking read per viewer would
cost a Redis connection per viewer. A missed doorbell costs latency rather than
data, and a 5s poll backs it up. See ADR-018.

A connection opens with a snapshot built by `buildRunProgress`, the same
function the worker publishes from, so the counts never jump when the first
update lands.

---

## 5. Scale strategy

| Pressure                       | Response                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 20k results in one run         | Batched inserts from the worker; the report tree is fetched per-node, never as one document                    |
| Millions of historical results | `test_result` RANGE-partitioned monthly on `started_at`; old partitions detached per retention policy          |
| Metrics over millions of rows  | Never computed on read. Worker maintains `daily_project_metrics`, `test_case_stats`, `matrix_coverage` rollups |
| 10k-row tables in the UI       | Server-side keyset pagination (not OFFSET) + TanStack Virtual                                                  |
| Live latency < 2s              | Redis pub/sub fan-out, no polling                                                                              |

---

## 6. Security posture

- RBAC enforced server-side in a NestJS guard; the UI hides what you cannot do,
  the API refuses it.
- GitHub webhook signatures verified (`X-Hub-Signature-256`, timing-safe compare)
  before the payload is parsed.
- API tokens stored as SHA-256 hashes with a displayable prefix. Shown once.
- GitHub App private key and token-signing secrets encrypted at rest.
- Rate limiting per token and per IP; ingestion has its own higher budget.
- pino redaction on `authorization`, `token`, `secret`, `password` paths.
