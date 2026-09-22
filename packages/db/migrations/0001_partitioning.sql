-- ADR-012: `test_result` is RANGE-partitioned monthly on `started_at`.
--
-- Done now, while the table is empty, because retrofitting partitioning onto a
-- table with hundreds of millions of rows means a full rewrite under an
-- exclusive lock. Retention then detaches a partition instead of issuing a
-- DELETE that would churn the whole table and its indexes.
--
-- The consequence, accepted deliberately: the primary key must contain the
-- partition key, so it is (id, started_at) rather than (id), and no other table
-- can hold a single-column foreign key to it. `step`, `attachment` and `triage`
-- therefore reference results without a database-level constraint. A foreign
-- key would block detaching an old partition in any case.

ALTER TABLE "test_result" RENAME TO "test_result_template";
--> statement-breakpoint

CREATE TABLE "test_result" (
  LIKE "test_result_template" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint

DROP TABLE "test_result_template";
--> statement-breakpoint

ALTER TABLE "test_result"
  ADD CONSTRAINT "test_result_id_started_at_pk" PRIMARY KEY ("id", "started_at");
--> statement-breakpoint

-- LIKE does not copy foreign keys, so they are restated here. A partitioned
-- table may reference ordinary tables; each partition inherits the constraint.
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_project_id_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_run_id_run_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_run_configuration_id_run_configuration_id_fk"
  FOREIGN KEY ("run_configuration_id") REFERENCES "public"."run_configuration"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_test_case_id_test_case_id_fk"
  FOREIGN KEY ("test_case_id") REFERENCES "public"."test_case"("id") ON DELETE cascade;
--> statement-breakpoint

-- Partitioned indexes: defined once on the parent, created automatically on
-- every partition, existing and future.
CREATE INDEX "test_result_case_started_idx" ON "test_result"
  USING btree ("project_id", "test_case_id", "started_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "test_result_run_idx" ON "test_result" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "test_result_run_config_case_idx" ON "test_result"
  USING btree ("run_configuration_id", "test_case_id");
--> statement-breakpoint
CREATE INDEX "test_result_signature_idx" ON "test_result"
  USING btree ("project_id", "error_signature_id", "started_at" DESC NULLS LAST);
--> statement-breakpoint

-- Creating a month's partition is idempotent, so the worker can call it ahead
-- of time on a schedule and the seed can call it for backdated demo data.
-- RLS is applied here too: a partition created after 0002_rls.sql ran would
-- otherwise be reachable without a tenant predicate.
CREATE OR REPLACE FUNCTION ensure_test_result_partition(target timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', target)::date;
  month_end   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name   text := format('test_result_%s', to_char(month_start, 'YYYYMM'));
BEGIN
  IF to_regclass(format('public.%I', part_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.test_result FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO eyesonbug_app', part_name);
  END IF;
  RETURN part_name;
END $$;
--> statement-breakpoint

-- A default partition means an event with an unexpected timestamp is stored
-- rather than rejected. For an ingestion endpoint that is the right trade:
-- a slightly slower plan beats failing a customer's CI job. The worker keeps
-- real partitions provisioned ahead, so it should stay empty.
CREATE TABLE "test_result_default" PARTITION OF "test_result" DEFAULT;
--> statement-breakpoint

-- Three months back, twelve forward. The worker extends the window nightly.
DO $$
DECLARE m int;
BEGIN
  FOR m IN -3..12 LOOP
    PERFORM ensure_test_result_partition(now() + make_interval(months => m));
  END LOOP;
END $$;
