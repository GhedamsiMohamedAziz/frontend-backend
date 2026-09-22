# Architecture Decision Records

Format: one short record per decision. Status is `proposed` until approved,
then `accepted`. Superseded records are kept, never deleted.

---

### ADR-001 — Product name: EyesOnBug

**Status:** accepted (2026-09-22) · **Context:** the spec said "TestHub", the
repo said "EyesOnBug". **Decision:** EyesOnBug, everywhere — packages
(`@eyesonbug/*`), database, docs, UI copy. **Consequence:** the npm scope
`@eyesonbug` should be reserved before M1 ships the reporter.

### ADR-002 — Multi-tenant SaaS, shared schema, enforced by RLS

**Status:** accepted · **Context:** many organizations share one deployment, so
a single missing `where organization_id = …` is a cross-tenant data leak.
**Decision:** shared database and schema with `organization_id` on every tenant
table, plus Postgres row-level security keyed on `current_setting('app.current_org_id')`.
The application role has no `BYPASSRLS`; migrations use a separate owner role.
**Alternatives:** schema-per-tenant (operationally heavy past a few hundred
tenants, migrations fan out); database-per-tenant (strongest isolation, worst
cost and pooling). **Consequence:** all DB access goes through a transaction
helper that sets the GUC — there is no second way to open a connection, and a
lint rule plus a test enforce it.

### ADR-003 — Drizzle over Prisma

**Status:** accepted · **Context:** the metrics layer needs partitioned tables,
rollups, partial indexes and hand-tuned aggregation SQL. **Decision:** Drizzle.
**Trade-off:** more boilerplate for plain CRUD, and no Prisma Studio. **Why it
wins here:** the schema stays one source of truth in TypeScript including the
parts Prisma cannot model, so migrations do not split into "Prisma schema" plus
"raw SQL we also run."

### ADR-004 — NestJS on Fastify

**Status:** accepted (2026-09-22) · **Context:** RBAC must be enforced server-side on every
route, and OpenAPI must be generated. **Decision:** NestJS (guards, DI, modules,
`@nestjs/swagger`) on the Fastify adapter for throughput on the ingest path.
**Alternative:** bare Fastify — less ceremony, but auth/RBAC/validation wiring
becomes per-route convention rather than a framework guarantee, which is exactly
the thing multi-tenancy cannot afford to get wrong once.

### ADR-005 — Server-Sent Events, not WebSockets

**Status:** accepted (2026-09-22) · **Context:** the live run view needs < 2s latency and is
strictly server→client. **Decision:** SSE over plain HTTP with `Last-Event-ID`
resume, fanned out via Redis pub/sub. **Alternative:** Socket.IO — needed only
if the client must push, which it does not (cancel/rerun are POSTs).
**Consequence:** production must not sit behind a proxy that buffers responses,
and this rules out deploying the API to a short-lived serverless runtime.

### ADR-006 — Matrix runs: one Run with many RunConfigurations

**Status:** accepted (2026-09-22) · **Context:** a matrix job produces N legs; are they one
run or many? **Decision:** one `Run` with N `run_configuration` rows, mirroring
GitHub's own `workflow_run` → `workflow_job` structure. A quality gate is a
statement about a Run, and a shareable link should point at "the run".
**Alternative:** parent/child runs — better independent addressability, but every
aggregate becomes two-level and the gate becomes distributed. **Escape hatch:**
`run.parent_run_id` exists and is nullable; reruns use `rerun_of_run_id` +
`rerun_kind` instead, so adopting the parent/child model later is additive.
Full write-up in `docs/SCHEMA.md §3`.

### ADR-007 — Test identity is a fingerprint, with human-confirmed aliases

**Status:** accepted (2026-09-22) · **Context:** trends and flakiness need an identity that
outlives a single run, but file renames and title edits change any content hash.
**Decision:** `sha256(project ‖ normalized path ‖ full title ‖ canonical params)`,
plus a `test_case_alias` table so a human can adopt an orphaned fingerprint into
an existing test case. **Alternative:** require an explicit stable ID annotation
in test code — more correct, but demands changing every existing test before the
tool delivers any value. **Consequence:** we can later _suggest_ merges
heuristically, but a human always confirms; a wrong auto-merge silently corrupts
history.

### ADR-008 — Ingestion is queued and idempotent; artifacts bypass the API

**Status:** accepted (2026-09-22) · **Context:** a 20k-result run must not be able to slow or
fail a CI job, and CI retries must not duplicate rows. **Decision:** the API
validates and returns `202`, the worker batch-writes; `Idempotency-Key` per
request and `eventId` per event, unique per project. Artifacts upload directly
to S3 via presigned PUTs and are read via short-lived signed GETs.
**Consequence:** the live view is eventually consistent by ~50ms, and a run's
totals are authoritative only after `/complete`.

### ADR-009 — Triage decisions freeze their context at decision time

**Status:** accepted (2026-09-22) · **Context:** M6 replays historical human decisions to
evaluate AI agreement, which requires the model to see exactly what the human
saw. **Decision:** `POST /triage` writes the decision and a versioned
`triage_context` JSONB snapshot in one transaction; if the snapshot cannot be
built, the decision is rejected. **Alternative:** re-derive context at training
time from live joins — cheaper now, but wrong later: tests get renamed,
artifacts expire under retention, and the stack normalizer changes, so the
replayed input would not be the input the human judged.

### ADR-010 — Metrics are never computed on read

**Status:** accepted (2026-09-22) · **Context:** projects reach millions of results.
**Decision:** worker-maintained rollup tables (`daily_project_metrics`,
`test_case_stats`, `matrix_coverage`, `triage_metrics`), refreshed incrementally
on run completion plus a nightly reconciliation. **Alternative:** Postgres
materialized views — simpler, but `REFRESH` is all-or-nothing and would rescan
history on every run. **Consequence:** dashboards can be briefly stale; the UI
shows the rollup's `updated_at` rather than implying real-time truth.

### ADR-011 — GitHub App, not OAuth App, for repository access

**Status:** accepted (2026-09-22) · **Context:** we need `checks:write` to report quality
gates and must act without a specific user's token. **Decision:** a GitHub App
with `actions:write`, `checks:write`, `contents:read`, `issues:write`,
`metadata:read`, installed per organization. User login stays OAuth.
**Note (verified 2026-09-22, M3):** the earlier assumption that
`workflow_dispatch` returns `204` with no run id is outdated. The endpoint
returns `200` with `workflow_run_id`, `run_url` and `html_url`, and accepts up
to 25 inputs. Dispatches therefore create their Run row directly; no
webhook correlation is needed.

### ADR-012 — `test_result` is partitioned from day one

**Status:** accepted (2026-09-22) · **Context:** a project accumulates millions
of results, and retention must eventually remove old ones. **Decision:** RANGE
partition `test_result` monthly on `started_at`, with
`ensure_test_result_partition()` provisioning months ahead and a DEFAULT
partition as a backstop. **Why now:** retrofitting partitioning onto a table
with hundreds of millions of rows is a full rewrite under an exclusive lock;
doing it while the table is empty costs one migration. **Consequences, accepted
deliberately:** the primary key must contain the partition key, so it is
`(id, started_at)`; no other table can hold a single-column foreign key to it,
so `step`, `attachment` and `triage` reference results without a database-level
constraint. A foreign key would block detaching an old partition in any case.
The DEFAULT partition means an out-of-window timestamp is stored rather than
rejected — for an ingestion endpoint, a slightly worse plan beats failing a
customer's CI job — and the worker warns if anything lands there.

### ADR-013 — `consistent-type-imports` is off in `apps/api`

**Status:** accepted (2026-09-22) · **Context:** NestJS resolves constructor
dependencies at runtime from the metadata `emitDecoratorMetadata` emits, and
that metadata only exists for imports that survive to runtime. **Decision:**
disable `@typescript-eslint/consistent-type-imports` for the API package.
**Why it is not a preference:** the rule rewrites an injected class to
`import type`, the emitted metadata degrades to `Object`, and the application
fails at boot with "Nest can't resolve dependencies". The two features cannot
both be enabled. Found the hard way, when `eslint --fix` silently broke a
previously green test suite.

### ADR-014 — Startup failures are printed, not logged

**Status:** accepted (2026-09-22) · **Context:** the API's boot-failure handler
wrote to pino and immediately called `process.exit(1)`; pino's pretty transport
is a worker thread, so the message was lost and the process exited with no
output at all. **Decision:** boot failures go to `console.error` first, and the
process sets `exitCode` rather than calling `exit`, so in-flight output flushes.
Nest's own logger is left enabled at `error`/`warn` for the same reason: with
`logger: false`, a missing optional peer dependency caused Nest to `process.exit`
silently. **Principle:** a failure in the logging path must not be able to hide
the failure it is reporting.

### ADR-015 — Playwright configuration dimensions come from project `metadata`

**Status:** accepted (2026-09-22) · **Context:** Playwright's JSON reporter does
not serialize a project's `use` block, so a report genuinely does not contain the
browser, locale or viewport a project ran with. **Decision:** read dimensions
from the project's `metadata`, which _is_ serialized, and fall back to inferring
the browser from the project name. Anything still unknown is left unset.
**Alternative:** parse `playwright.config.ts` — requires executing the user's
config in our process, which is neither safe nor generally possible from a
report file. **Consequence:** a repo that wants locale as a filterable dimension
adds three words to each project; one that does not still gets one configuration
row per Playwright project. **Deliberately not guessed:** a wrong dimension is
worse than a missing one, because it silently splits a test's history in two.

### ADR-016 — Ingestion folds events in passes, not in arrival order

**Status:** accepted (2026-09-22) · **Context:** the worker resolved each
`test.finished` against a map built by `test.started`, walking events in stored
order. **Decision:** three ordered passes — configurations, then test
identities, then everything that depends on them. **Why:** a zero-duration
result (every skipped test) produces `test.started` and `test.finished` with an
identical timestamp, so their relative order came down to a tiebreak on a random
id; when `finished` won, the result was dropped and the run silently
under-reported. Events also arrive in batches over HTTP and can be replayed by a
CI retry, so arrival order was never something the protocol guaranteed.
**Consequence:** the fold is order-independent by construction rather than by
luck. Regression test: `apps/worker/test/ingest.test.ts` stores the events
reversed and with identical timestamps.

### ADR-017 — Error signatures exclude the call log and the code frame

**Status:** accepted (2026-09-22) · **Context:** Playwright appends a call log
and a snippet of the source around the failing line to every assertion message.
**Decision:** truncate the message at the first call-log or code-frame marker
before hashing, and strip terminal colour codes before _storing_ rather than
only before hashing. **Why:** the snippet contains small line numbers that
normalization deliberately preserves, so adding an import at the top of a file
shifted every line in the frame, changed the hash, and split one cluster into
two — the exact failure that error signatures exist to prevent. The colour codes
rendered as literal escape sequences in the report.

### ADR-018 — Live transport: a Redis stream for data, pub/sub for the doorbell

**Status:** accepted (2026-09-22) · **Context:** the live view needs sub-2s
updates and must survive a browser reconnect. **Decision:** the worker appends
each update to a capped, expiring Redis **stream** per run and publishes an
empty message on a pub/sub **channel**; the API keeps one subscriber per
process and, when woken, reads the stream from each client's last id.
**Why not pub/sub alone:** a client that drops for three seconds would miss
every message in that window and show stale counts until a full refetch. The
stream is the durable buffer that makes `Last-Event-ID` resume real.
**Why not a stream alone:** a blocking `XREAD` per viewer means a Redis
connection per viewer. **Consequence:** a lost doorbell costs latency, not data,
and a 5s poll backs it up.

### ADR-019 — `running` is a stored result status, and refs are columns

**Status:** accepted (2026-09-22) · **Context:** streaming delivers a run in
many batches, each its own processing pass. The first implementation rebuilt the
`configurationRef → id` and `resultRef → row` maps from the current batch, so
every pass after the first failed to attach anything — a streamed run finished
with **zero** results recorded. **Decision:** store the reporter's correlation
keys as `run_configuration.ref` and `test_result.result_ref`, and write the
result row when the test _starts_, with a new `running` status, updating it when
it finishes. **Why this shape:** a test that has started and not finished is
genuinely part of a live run's state, so the row should exist; once it does, the
live view can show what is executing now, which the spec asks for. `total`
counts finished work only, so progress never appears to go backwards when an
in-flight test resolves. **Consequence:** one UPDATE per result instead of one
INSERT, and every read path that is not the live view filters out `running`.

### ADR-020 — The ETA extrapolates from this run, not from history

**Status:** accepted (2026-09-22) · **Context:** the live view needs a finish
estimate. **Decision:** take the _denominator_ from history — the median result
count of the last five completed runs — and the _rate_ from this run's own
elapsed time per result. **Why:** the rate already accounts for however much
parallelism the job has today: shard count, runner size, a busy CI queue.
Historical durations do not, and would be confidently wrong whenever the job
shape changed. Below five results the rate is dominated by start-up cost, so no
estimate is shown at all — nothing beats a number that swings by minutes
between updates.

### ADR-021 — Cancellation is cooperative until the GitHub App lands

**Status:** accepted (2026-09-22) · **Context:** the spec wants Cancel and
Rerun through GitHub Actions, which needs the GitHub App from M3.
**Decision:** ship Cancel now as a cooperative stop — the run is marked
cancelled, in-flight results are resolved as `broken`, and the reporter sees the
status on its next flush and stops sending. The button's tooltip says plainly
that the CI job itself keeps running. **Rerun is not shipped at all:** a button
that cannot do anything is worse than no button. **Consequence:** a reporter
batch can be in flight when the cancel lands, so the sweep that resolves
`running` rows runs on every pass rather than once, making the race
self-correcting.

### ADR-022 — GitHub client on the standard library, not Octokit

**Status:** accepted (2026-09-22) · **Context:** M3 needs eight GitHub
endpoints: installation token, installation lookup, repositories, workflows,
a file, dispatch, cancel/rerun, and check runs. **Options:** (A)
`@octokit/auth-app` + `@octokit/rest`, typed and paginated, two new
dependencies and a large surface to stub in tests; (B) `node:crypto` for the
RS256 App JWT and `fetch` for the calls, with the base URL injectable.
**Decision:** B, in `@eyesonbug/shared/node` so the API and the worker share
one client. Every call was checked against docs.github.com rather than
inferred. **Consequence:** tests run against an in-process fake GitHub
(`node:http`) instead of mocking a library. If the surface grows past
hand-rolled pagination, the request core is swapped for Octokit behind the
same method signatures.

### ADR-023 — Webhook deliveries are folded by GitHub's ids, not logged

**Status:** accepted (2026-09-22) · **Context:** GitHub redelivers on
request and the same event can arrive twice. **Decision:** no delivery table.
The receiver verifies `X-Hub-Signature-256` over the raw body and queues the
event; the worker upserts by `installation.id` and `workflow_run.id`, so a
redelivery is a no-op. A `workflow_run` never reopens a run the reporter has
sealed, and only moves a run that reported nothing to a terminal state.
**Consequence:** unknown events are acknowledged and dropped; anything worth
auditing is visible in GitHub's own delivery log.
