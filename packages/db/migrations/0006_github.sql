ALTER TABLE "run" ADD COLUMN "workflow_config_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "dispatch_inputs" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "gate" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "github_check_run_id" bigint;