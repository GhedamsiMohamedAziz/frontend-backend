# EyesOnBug — Database Schema

> Status: **accepted and migrated**. Every table below exists in
> `packages/db/migrations`.
> Postgres 16 + Drizzle. Every tenant table carries `organization_id` and an RLS policy.
> All PKs are `uuid v7` (time-sortable — good index locality, no sequence contention).

---

## 1. Tenancy & identity

```
organization        id, slug↑, name, plan, created_at
user                id, github_user_id↑, email, name, avatar_url, locale, created_at
org_membership      org_id, user_id, role: owner|admin|member      PK(org_id,user_id)
project             id, org_id, slug, name, repo_full_name, default_branch,
                    settings jsonb, created_at, archived_at        ↑(org_id, slug)
project_membership  project_id, user_id, role: admin|maintainer|qa|viewer
team                id, org_id, slug, name
team_membership     team_id, user_id
environment         id, project_id, name, base_url, is_production   ↑(project_id, name)
api_token           id, org_id, project_id?, name, token_hash↑, token_prefix,
                    scopes text[], expires_at, last_used_at, created_by, revoked_at
audit_log           id, org_id, actor_user_id?, actor_token_id?, action,
                    subject_type, subject_id, before jsonb, after jsonb, ip, created_at
```

**Role model.** `org_membership.role` governs org-wide settings (billing, GitHub
App, members). `project_membership.role` governs a single project. An org `owner`
or `admin` is implicitly `admin` on every project in the org. `Viewer` is
read-only; `QA` can triage and rerun; `Maintainer` adds workflow config and
schedules; `Admin` adds tokens, roles and retention.

---

## 2. Test taxonomy — stable identity across runs

```
suite               id, project_id, name, path
feature             id, project_id, key↑(project_id,key), name, description,
                    source: gherkin|annotation|path, owner_team_id?
test_case           id, project_id, fingerprint, suite_id?, feature_id?,
                    file_path, title, full_title, params jsonb,
                    owner_team_id?, quarantined_at?, quarantine_reason?,
                    first_seen_at, last_seen_at, retired_at?
                                                      ↑(project_id, fingerprint)
test_case_alias     test_case_id, fingerprint↑, reason: rename|merge|manual,
                    merged_by, merged_at
tag                 id, project_id, name             ↑(project_id, name)
test_case_tag       test_case_id, tag_id
```

### The fingerprint

`sha256(project_id ‖ normalized_file_path ‖ full_title ‖ canonical_json(params))`

Path is normalized to repo-relative POSIX form so runner working directories do
not change identity. Params are canonicalised (sorted keys) so a
parameterised test keeps one identity per parameter set.

**Renames break this** — and renames are routine. `test_case_alias` is the
answer: a fingerprint that no longer resolves can be pointed at an existing
`test_case`, from the UI ("this is the test formerly at …"), and lookup always
goes `fingerprint → alias → test_case`. History, flakiness and trends survive.
A later heuristic can _suggest_ merges (same file, high title similarity,
appeared the run the old one vanished), but a human confirms.

---

## 3. Execution

```
configuration       id, project_id, fingerprint↑(project_id,fingerprint),
                    browser, browser_version, device, os, os_version,
                    viewport, locale, dimensions jsonb, first_seen_at
run                 id, project_id, number, status, trigger, branch, commit_sha,
                    commit_message, commit_author, build_version, environment_id?,
                    github_workflow_run_id?, github_workflow_name?, github_run_attempt,
                    parent_run_id?, rerun_of_run_id?, rerun_kind?: failed|all,
                    triggered_by_user_id?, triggered_by_token_id?,
                    queued_at, started_at?, finished_at?, duration_ms?,
                    totals jsonb, metadata jsonb        ↑(project_id, number)
run_configuration   id, run_id, project_id, configuration_id, status,
                    shard_index?, shard_total?, github_job_id?,
                    started_at?, finished_at?, totals jsonb
test_result         id, project_id, run_id, run_configuration_id, test_case_id,
                    status: passed|failed|skipped|broken|flaky,
                    retry_index, is_final_attempt, duration_ms,
                    started_at, finished_at,
                    error_type?, error_message?, stack_trace?, normalized_stack?,
                    error_signature_id?, was_quarantined, worker_id?
                                        PARTITION BY RANGE (started_at), monthly
step                id, project_id, test_result_id, parent_step_id?, position,
                    path ltree, keyword?: given|when|then|and|but,
                    title, status, duration_ms, error_message?, started_at
attachment          id, project_id, test_result_id?, step_id?,
                    kind: screenshot|video|trace|log|har,
                    s3_key, content_type, size_bytes, sha256,
                    width?, height?, expires_at?, created_at
ingest_event        id, project_id, idempotency_key↑(project_id,key),
                    run_id?, kind, payload jsonb, received_at, processed_at?
```

### Matrix runs: one Run, many RunConfigurations — with a parent escape hatch

**Option A — single `Run` + N `run_configuration` rows.** One GitHub
`workflow_run` is one Run; each matrix leg is a `workflow_job` and maps to a
`run_configuration`. A quality gate is a statement about a Run, and the run
report's matrix heatmap is a single query.
_Cost:_ a matrix leg that fails to start leaves a configuration in limbo the Run
must account for.

**Option B — parent Run with child Runs.** Each leg is independently
addressable, rerunnable and gateable.
_Cost:_ every aggregate becomes a two-level query, the gate becomes a
distributed decision, and "the run" stops being a thing you can link to.

**Recommendation: A.** It matches GitHub's own object model, and the report and
gate are both naturally Run-scoped. Option B's only real advantage — independent
reruns — is recovered by `run.rerun_of_run_id` + `rerun_kind`, which links a
rerun to what it re-ran without pretending it is a child of it. `parent_run_id`
is kept nullable and unused at M0, so switching to B later is an additive
migration rather than a rewrite.

### Retries, and what `flaky` means

Every attempt is a `test_result` row with an increasing `retry_index`; only the
last carries `is_final_attempt`. Nothing is overwritten — the evidence of a
retry _is_ the flakiness signal.

`status = 'flaky'` is derived, not reported: a test whose attempts within one
run+configuration both failed and passed. The broader _flakiness score_ on
`test_case_stats` uses your definition (passes and fails on the same
commit+configuration) over a rolling window — default **last 50 results within
14 days**, configurable per project.

---

## 4. Clustering, triage, and the M6 dataset

```
error_signature     id, project_id, hash↑(project_id,hash),
                    normalized_message, normalized_stack_head, error_type,
                    first_seen_at, last_seen_at, occurrence_count,
                    known_issue_id?
triage              id, project_id, error_signature_id?, test_result_id?,
                    category: product_bug|test_bug|environment|flaky|
                              known_issue|needs_investigation,
                    assignee_user_id?, comment?, known_issue_id?,
                    source: human|ai, confidence numeric?,
                    triaged_by?, triaged_at, superseded_by?,
                    resolution?: fixed|wont_fix|invalid|duplicate, resolved_at?
triage_context      triage_id↑, payload jsonb, schema_version
known_issue         id, project_id, title, tracker: github|jira,
                    external_key, external_url, status, created_by, created_at
known_issue_signature  known_issue_id, error_signature_id
comment             id, project_id, subject_type, subject_id, author_id,
                    body, mentions uuid[], created_at, edited_at
```

### The error signature

`sha256(error_type ‖ normalized_message ‖ top_n_app_frames)` where normalization
strips absolute paths, line/column numbers, hex addresses, UUIDs, timestamps,
ports and numeric literals, and the stack is filtered to frames inside the repo
(node_modules and runner internals dropped). This is what makes "12 tests failed
with the same timeout on /checkout" one triage decision instead of twelve.

### `triage_context` is the M6 requirement, not a nice-to-have

A triage decision is only a usable training label if the _input_ is recoverable
exactly as the human saw it. Re-deriving it later from live joins is wrong:
the test was since renamed, the run's artifacts expired, the stack normalizer
was improved. So at decision time we freeze a versioned snapshot:

```jsonc
{
  "schema_version": 1,
  "error":   { "type", "message", "normalized_message", "stack", "normalized_stack" },
  "test":    { "fingerprint", "title", "feature", "owner_team", "file_path" },
  "config":  { "browser", "os", "device", "locale", "environment" },
  "run":     { "branch", "commit_sha", "trigger", "build_version" },
  "history": { "last_30_statuses", "flakiness_score", "days_since_first_failure" },
  "cluster": { "signature_hash", "sibling_count", "features_affected" },
  "evidence":{ "log_tail", "screenshot_keys", "step_trail" }
}
```

Paired with `triage.category` (the label) and `triage.resolution` (the label
verified by outcome), this is a replayable dataset from day one. The M6
evaluation harness replays these snapshots and measures agreement — which is
only possible because the snapshot is immutable.

---

## 5. Automation & delivery

```
github_installation id, org_id, installation_id↑, account_login,
                    repositories jsonb, suspended_at?
workflow_config     id, project_id, repo_full_name, workflow_file, ref,
                    name, inputs_schema jsonb, default_inputs jsonb, enabled
schedule            id, project_id, workflow_config_id, cron, timezone,
                    inputs jsonb, enabled, next_run_at, last_run_at
quality_gate        id, project_id, name, rules jsonb, report_as: check_run,
                    enabled, applies_to_branches text[]
notification_rule   id, project_id, event: run_failed|run_recovered|new_flaky|
                    new_failure, channel: slack|teams|email, target,
                    filter jsonb, enabled
retention_policy    id, project_id, artifact_kind, keep_days
saved_view          id, project_id, user_id?, name, scope: history|metrics|triage,
                    filters jsonb, is_shared
```

`workflow_config.inputs_schema` is populated by reading the workflow file's
`workflow_dispatch.inputs` via the GitHub API, so the run-launcher form is
generated rather than hand-maintained.

---

## 6. Rollups (worker-maintained, never computed on read)

```
test_case_stats        test_case_id, window: 7d|14d|30d,
                       runs, passed, failed, skipped, flaky_transitions,
                       flakiness_score, p50_duration_ms, p95_duration_ms,
                       last_failure_at, last_passed_at, updated_at
daily_project_metrics  project_id, day, feature_id?, configuration_id?,
                       environment_id?, total, passed, failed, skipped, flaky,
                       duration_p50_ms, duration_p95_ms
matrix_coverage        project_id, feature_id, configuration_id,
                       last_run_at, last_status
triage_metrics         project_id, day, untriaged_count,
                       mean_time_to_triage_s, mean_time_to_fix_s
```

Refreshed incrementally on run completion (only the touched slices), plus a
nightly full reconciliation to heal drift. Rollup rows are dimension-sliced with
nullable dimension columns so one table serves "pass rate by feature", "by
locale" and "overall" without a fan-out of tables.

---

## 7. Key indexes

```
test_result   (project_id, test_case_id, started_at DESC)   -- history strip
              (run_id, status) WHERE status <> 'passed'     -- failures first
              (project_id, error_signature_id, started_at DESC)
              (run_configuration_id, test_case_id)
run           (project_id, started_at DESC)
              (project_id, branch, started_at DESC)
              (github_workflow_run_id)
test_case     (project_id, fingerprint) UNIQUE
              (project_id, feature_id) WHERE retired_at IS NULL
attachment    (test_result_id, kind)
              (expires_at) WHERE expires_at IS NOT NULL     -- retention reaper
ingest_event  (project_id, idempotency_key) UNIQUE          -- idempotency
```

Partial indexes on `status <> 'passed'` matter: in a healthy project 98% of rows
are passes, and every failure-oriented screen would otherwise scan them.
