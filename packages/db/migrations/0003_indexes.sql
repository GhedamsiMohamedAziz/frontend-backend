-- Indexes Drizzle cannot express: partial, expression, trigram and GiST.
--
-- The partial ones matter more than they look. In a healthy project ~98% of
-- test_result rows are passes, so every failure-oriented screen — the report's
-- failure list, the triage inbox, "new failures since last run" — would
-- otherwise read an index dominated by rows it immediately discards.

-- Failures within a run, which is what the run report opens with.
CREATE INDEX "test_result_run_failures_idx" ON "test_result" ("run_id", "status")
  WHERE "status" <> 'passed' AND "status" <> 'skipped';
--> statement-breakpoint

-- The triage inbox: recent failures in a project that carry a signature.
CREATE INDEX "test_result_project_failures_idx"
  ON "test_result" ("project_id", "started_at" DESC)
  WHERE "status" <> 'passed' AND "status" <> 'skipped';
--> statement-breakpoint

-- The history strip on a test detail drawer only ever wants final attempts.
CREATE INDEX "test_result_final_attempt_idx"
  ON "test_result" ("test_case_id", "started_at" DESC)
  WHERE "is_final_attempt";
--> statement-breakpoint

-- Retention reaper: the vast majority of attachments have no expiry.
DROP INDEX IF EXISTS "attachment_expires_idx";
--> statement-breakpoint
CREATE INDEX "attachment_expires_idx" ON "attachment" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint

-- Live tests exclude retired ones from every listing and count.
CREATE INDEX "test_case_active_idx" ON "test_case" ("project_id", "feature_id")
  WHERE "retired_at" IS NULL;
--> statement-breakpoint

CREATE INDEX "test_case_quarantined_idx" ON "test_case" ("project_id")
  WHERE "quarantined_at" IS NOT NULL;
--> statement-breakpoint

-- Fuzzy search over test titles, for the command palette and list search.
CREATE INDEX "test_case_title_trgm_idx" ON "test_case"
  USING gin ("full_title" gin_trgm_ops);
--> statement-breakpoint

-- Clustered failure messages are searched the same way.
CREATE INDEX "error_signature_message_trgm_idx" ON "error_signature"
  USING gin ("normalized_message" gin_trgm_ops);
--> statement-breakpoint

-- Whole step subtrees in one indexed lookup.
CREATE INDEX "step_path_idx" ON "step" USING gist ("path");
--> statement-breakpoint

-- The ingest worker claims unprocessed events; processed rows are the bulk.
DROP INDEX IF EXISTS "ingest_event_unprocessed_idx";
--> statement-breakpoint
CREATE INDEX "ingest_event_unprocessed_idx" ON "ingest_event" ("received_at")
  WHERE "processed_at" IS NULL AND "failed_at" IS NULL;
--> statement-breakpoint

-- The triage inbox is "failures whose signature has no decision yet".
CREATE INDEX "triage_open_idx" ON "triage" ("project_id", "triaged_at" DESC)
  WHERE "superseded_by_id" IS NULL;
--> statement-breakpoint

-- Sessions are swept by expiry; revoked ones are already unusable.
DROP INDEX IF EXISTS "session_expires_idx";
--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" ("expires_at")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- Live tokens only. Revoked and expired tokens stay for the audit trail.
CREATE INDEX "api_token_active_idx" ON "api_token" ("organization_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- Metrics slices are looked up by their dimension combination, and a NULL
-- dimension means "all". A plain composite index cannot serve that, because
-- NULLs are not equal to each other, so the unique key is on the coalesced
-- expression.
CREATE UNIQUE INDEX "daily_project_metrics_slice_key" ON "daily_project_metrics" (
  "project_id",
  "day",
  coalesce("feature_id", '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce("configuration_id", '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce("environment_id", '00000000-0000-0000-0000-000000000000'::uuid)
);
