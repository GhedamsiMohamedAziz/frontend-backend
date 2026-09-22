ALTER TYPE "public"."result_status" ADD VALUE 'running';--> statement-breakpoint
ALTER TABLE "run_configuration" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "test_result" ADD COLUMN "result_ref" text;--> statement-breakpoint
CREATE INDEX "run_configuration_ref_idx" ON "run_configuration" USING btree ("run_id","ref");--> statement-breakpoint
CREATE INDEX "test_result_run_ref_idx" ON "test_result" USING btree ("run_id","result_ref");