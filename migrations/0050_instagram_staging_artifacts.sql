ALTER TABLE "provider_staging_artifacts" ADD COLUMN "artifact_key" text;
ALTER TABLE "provider_staging_artifacts" ADD COLUMN "artifact_kind" text DEFAULT 'legacy' NOT NULL;
ALTER TABLE "provider_staging_artifacts" ADD COLUMN "artifact_status" text DEFAULT 'initialized' NOT NULL;
ALTER TABLE "provider_staging_artifacts" ADD COLUMN "redacted_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "provider_staging_artifacts"
SET "artifact_key" = 'legacy:' || "id"::text
WHERE "artifact_key" IS NULL;

ALTER TABLE "provider_staging_artifacts" ALTER COLUMN "artifact_key" SET NOT NULL;
ALTER TABLE "provider_staging_artifacts" ALTER COLUMN "artifact_key" SET DEFAULT 'legacy:' || gen_random_uuid()::text;
ALTER TABLE "provider_staging_artifacts" ALTER COLUMN "media_id" DROP NOT NULL;

CREATE UNIQUE INDEX "provider_staging_job_artifact_key_unique"
ON "provider_staging_artifacts" USING btree ("workspace_id", "job_id", "artifact_key");
