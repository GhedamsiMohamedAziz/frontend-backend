-- Fix: partitions created after 0002_rls.sql ran had RLS enabled but no policy
-- attached. Enabling RLS without a policy denies everything, and creating a
-- partition should never be able to make ingestion start failing next month.
--
-- Creating the policy on the partition is correct regardless of how the rows
-- are reached: the parent's policy covers access through `test_result`, and the
-- partition's own covers anything that touches the partition directly.

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
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (organization_id = current_org_id())
         WITH CHECK (organization_id = current_org_id())',
      part_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO eyesonbug_app', part_name);
  END IF;
  RETURN part_name;
END $$;
