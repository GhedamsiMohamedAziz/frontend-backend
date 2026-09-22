# Build Prompt: "TestHub", an Acceptance Test Orchestration & Reporting Platform

> Paste this whole file into Claude Code / Claude, or save it as `.github/copilot-instructions.md` (plus a `docs/SPEC.md`) for GitHub Copilot.
> Work milestone by milestone. **Do not start a milestone until the previous one builds, passes its tests, and runs locally with `docker compose up`.**

---

## 1. Role & goal

You are a senior full-stack TypeScript engineer and product-minded UX designer. Build **TestHub**, a web platform for acceptance/E2E test teams that:

1. Shows **live test runs** in real time.
2. Keeps a searchable **history** of runs and of every individual test.
3. Displays rich **reports** (steps, logs, screenshots, videos, traces).
4. Lets users **filter** by feature, language/locale, configuration (browser, device, OS, environment, branch, build, tag…).
5. Provides **metrics & trends** (pass rate, flakiness, duration, failures by feature).
6. Offers an **admin back office** to configure and trigger **GitHub Actions** runs.
7. Supports **manual triage and bug reporting** now, with a data model designed for **AI-assisted triage** in a later milestone.

The UI must be **exceptionally easy to use**: a QA engineer, a developer and a product manager should each find what they need in under 3 clicks.

---

## 2. Tech stack (TypeScript everywhere, strict mode)

- **Monorepo:** pnpm workspaces + Turborepo
  - `apps/web`: Next.js (App Router) + React + TypeScript
  - `apps/api`: NestJS (or Fastify) + TypeScript
  - `apps/worker`: background jobs (ingestion, GitHub sync, notifications)
  - `packages/shared`: shared types, Zod schemas, API contracts
  - `packages/reporter`: npm package / CLI that CI jobs use to stream results to TestHub
- **UI:** Tailwind CSS + shadcn/ui, TanStack Query, TanStack Table, ECharts or Recharts, lucide icons, cmdk command palette
- **Database:** PostgreSQL + Prisma (or Drizzle). Use JSONB for flexible metadata.
- **Queue/cache:** Redis + BullMQ
- **Realtime:** Server-Sent Events or WebSockets (Socket.IO) for live runs
- **Artifact storage:** S3-compatible (MinIO locally) for screenshots, videos, Playwright traces, logs
- **Auth:** GitHub OAuth / OIDC SSO, with RBAC
- **GitHub integration:** a **GitHub App** via Octokit (`workflow_dispatch`, webhooks for `workflow_run`, `workflow_job`, `check_run`)
- **Validation:** Zod on every API boundary
- **Testing:** Vitest (unit), Supertest (API), Playwright (E2E of TestHub itself)
- **Quality:** ESLint, Prettier, strict `tsconfig`, Husky + lint-staged, conventional commits
- **Ops:** Docker Compose for local dev, OpenTelemetry, structured logs (pino), `/health` and `/ready` endpoints
- **Docs:** OpenAPI generated from the API; README with setup in under 5 minutes

---

## 3. Domain model (design this first, then show me the schema before coding)

Core entities (adjust names if you have better ones, but explain why):

- **Organization, Project**: multi-project from day one
- **Suite**: a logical group of tests (e.g. "Checkout acceptance")
- **TestCase**: a stable identity for a test across runs. Use a **fingerprint** (hash of file path + full title + parameters) so history, flakiness and trends follow the test even when reruns happen.
- **Run**: one execution. Fields: status (queued, running, passed, failed, cancelled, errored), trigger (manual, schedule, push, PR, API), branch, commit SHA, build/version, environment, GitHub workflow run ID, started/finished/duration, triggered by.
- **RunConfiguration**: browser, device, OS, viewport, locale/language, environment, feature flags, plus free-form key/value dimensions. Matrix runs = one Run with many configurations, or a parent run with child runs (choose and justify).
- **TestResult**: TestCase × Run × Configuration. Fields: status (passed, failed, skipped, broken, flaky), retries, duration, error message, **normalized stack trace**, **error signature** (hash of normalized error for clustering).
- **Step**: nested steps (Given/When/Then for BDD) with status, duration and attachments.
- **Attachment**: screenshot, video, trace, log, HAR, stored in S3 with signed URLs.
- **Tag / Feature / Owner**: tests belong to features (from Gherkin feature files, annotations or path conventions) and to owning teams.
- **Triage**: per failed result or per failure cluster. Fields: category (**product bug, test bug, environment issue, flaky, known issue, needs investigation**), assignee, comment, linked issue, triaged by, triaged at, and `source: "human" | "ai"` plus `confidence` (nullable for now).
- **KnownIssue / BugReport**: linked to GitHub Issues / Jira, auto-matched by error signature.
- **Schedule, WorkflowConfig, Environment, ApiToken, AuditLog, NotificationRule**

**Important:** every human triage decision is stored with enough context (error, stack, logs, screenshot refs, category, final resolution) to become a **labeled dataset for the future AI triage milestone**. Treat this as a first-class requirement.

---

## 4. Result ingestion

- Accept results from multiple frameworks via adapters: **Playwright JSON, JUnit XML, Cucumber JSON, Allure results, WebdriverIO, Cypress**.
- Two ingestion modes:
  1. **Streaming**: `packages/reporter` sends events (run started, test started/finished, step, attachment) during execution so the live view updates in real time.
  2. **Batch upload**: POST a results archive at the end of a job.
- Authenticate with per-project API tokens. Ingestion must be idempotent (retries from CI must not duplicate results).
- Provide a ready-to-copy GitHub Actions snippet in the UI showing how to add the reporter to an existing workflow.

---

## 5. Features by screen

### 5.1 Dashboard (home)

- Health summary per project: latest run status, pass rate, trend sparkline, flaky count, untriaged failures.
- "Needs your attention" list: untriaged failures, new failures since last run, tests owned by my team.
- Currently running runs with progress bars.

### 5.2 Live run view

- Real-time progress: total / passed / failed / skipped / running, ETA based on historical durations.
- Per-worker / per-shard lanes (timeline or Gantt style).
- Failures appear instantly at the top with error preview and screenshot thumbnail.
- Cancel / rerun-failed buttons (through GitHub Actions).

### 5.3 Run history

- Table with powerful filters: project, branch, environment, configuration dimensions, **feature, language/locale**, trigger, status, date range, commit, build.
- **Filters are saved in the URL** (shareable links) and can be saved as named views.
- Compare two runs: new failures, fixed tests, still failing, duration regressions.

### 5.4 Run report

- Tree grouped by feature → scenario → configuration, with a switchable grouping (by feature, by config, by status, by owner).
- Matrix view: tests × configurations heatmap (e.g. rows = scenarios, columns = browser × locale).
- Failures grouped by **error signature** ("12 tests failed with the same timeout on /checkout").
- Test detail drawer: steps, error, stack trace with source links to GitHub at the commit SHA, screenshots gallery, video player, Playwright trace viewer link, logs, retries, and **history strip** (last 30 results of this test).

### 5.5 Test case page

- Full history across runs and configurations, pass rate, flakiness score, average duration trend, last failure, linked bugs, owner.
- Quarantine toggle (quarantined tests still run but do not fail the gate).

### 5.6 Metrics & analytics

- Pass rate over time (by project, feature, configuration, locale)
- Flakiness ranking (a test that both passes and fails on the same commit/config is flaky)
- Slowest tests and duration regressions
- Failures by feature, by category (from triage), by environment
- Mean time to triage, mean time to fix, untriaged backlog
- Coverage of the configuration matrix (which feature × locale × browser combos were never run)
- Export to CSV; all charts filterable the same way as history

### 5.7 Triage & bug reports (manual now)

- Triage inbox: untriaged failures, grouped by error signature, keyboard-driven (J/K to navigate, number keys to categorize).
- Bulk triage: apply one decision to a whole cluster.
- **"Create bug report"** button: prefilled GitHub Issue (or Jira) with title, environment, configuration, steps, error, screenshot, links to run & trace. Editable before submit.
- Auto-link future failures with the same signature to an existing known issue.
- Comments and @mentions on results.

### 5.8 Admin back office

- Projects, environments, teams/owners, users & roles (**Admin, Maintainer, QA, Viewer**).
- **GitHub integration:** install GitHub App, pick repos, list workflows, map workflows to projects.
- **Run launcher / workflow configs:** define reusable run templates: workflow file, ref/branch, inputs (environment, browsers, locales, tags/feature filter, shard count), with a form generated from the workflow's `workflow_dispatch` inputs.
- **Schedules:** cron-based runs (nightly, pre-release), with a human-readable preview ("every weekday at 02:00 Europe/Paris").
- **Quality gates:** rules like "pass rate ≥ 98% and no new failures" → report back to GitHub as a commit status/check.
- Notification rules: Slack / Microsoft Teams / email on failure, on recovery, on new flaky test.
- API tokens, retention policies (e.g. keep videos 30 days, results 1 year), audit log of every admin action.

---

## 6. UX requirements (non-negotiable)

- Clean, calm design; strong visual hierarchy; status colors that are also distinguishable by icon/shape (colorblind-safe).
- Light & dark mode.
- **Command palette (Ctrl/Cmd+K):** jump to any run, test, feature, or action.
- Global filter bar that stays consistent across History, Report and Metrics.
- Every list: fast search, sort, column chooser, pagination or virtualization for 10k+ rows.
- Empty states that teach (e.g. "No runs yet: here's the snippet to add to your workflow").
- Loading skeletons, optimistic updates, no layout shift.
- Responsive (usable on a phone for checking a run), WCAG 2.1 AA, full keyboard navigation.
- i18n-ready UI (at least English and French).
- Deep links everywhere: every run, test, result, step and filter state has a shareable URL.

---

## 7. Non-functional requirements

- Handle runs with **20,000+ test results** and projects with millions of historical results: index properly, paginate server-side, pre-aggregate metrics (materialized views or rollup tables refreshed by the worker).
- Live updates under 2 seconds latency.
- Security: RBAC enforced server-side, signed artifact URLs, secrets encrypted at rest, GitHub webhook signature verification, rate limiting, no secrets in logs.
- Multi-tenant-safe queries (always scoped by organization/project).
- Seed script with realistic demo data (several projects, features, locales, browsers, flaky tests, triaged failures) so the UI can be evaluated immediately.

---

## 8. Milestones

**M0: Foundations.** Monorepo, Docker Compose (Postgres, Redis, MinIO), auth, RBAC, CI for TestHub itself, domain schema + migrations, seed data.

**M1: Ingestion & reports.** Reporter package, adapters (Playwright + JUnit first), run history, run report, test detail, attachments.

**M2: Live runs.** Streaming ingestion, realtime live view, ETA, cancel/rerun.

**M3: GitHub back office.** GitHub App, workflow mapping, run templates, manual trigger, schedules, webhooks sync, quality gates as commit checks.

**M4: Metrics & flakiness.** Aggregations, dashboards, flaky detection, quarantine, run comparison.

**M5: Triage & bug reports.** Triage inbox, error-signature clustering, known issues, GitHub Issues/Jira bug creation, notifications.

**M6 (later, design only for now): AI triage.** Prepare but do not implement: a `TriageSuggestion` interface, a provider abstraction (e.g. Claude via API), an evaluation harness that replays historical human triage decisions and measures AI agreement, and UI slots where AI suggestions will appear with confidence + "accept / reject" (rejections are recorded as feedback). AI must **suggest**, humans **decide**.

---

## 9. How I want you to work

1. Start by restating the requirements in your own words and listing **open questions and assumptions**. Wait for my answers before M0.
2. Propose the architecture diagram, the database schema and the API route list. Wait for approval.
3. For each milestone: plan → implement → write tests → run them → summarize what changed and how to try it.
4. Keep functions small, types explicit, no `any`. Shared contracts live in `packages/shared`.
5. When a decision has trade-offs (e.g. parent/child runs vs single run with matrix), present 2 options with pros/cons and a recommendation.
6. Never invent GitHub API behavior: check the official docs for `workflow_dispatch`, webhooks and GitHub App permissions.
7. Keep a `docs/DECISIONS.md` (ADR-style) and update the README at every milestone.
