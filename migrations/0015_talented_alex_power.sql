DROP INDEX "api_keys_prefix_unique";--> statement-breakpoint
DROP INDEX "provider_staging_job_media_unique";--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD COLUMN "upload_phase" text DEFAULT 'initialized' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD COLUMN "next_segment" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_unique" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_staging_job_media_unique" ON "provider_staging_artifacts" USING btree ("workspace_id","job_id","media_id") WHERE "provider_staging_artifacts"."deleted_at" is null;