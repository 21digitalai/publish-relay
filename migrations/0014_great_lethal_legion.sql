CREATE UNIQUE INDEX "provider_staging_job_media_unique" ON "provider_staging_artifacts" USING btree ("workspace_id","job_id","media_id") WHERE "deleted_at" is null;
