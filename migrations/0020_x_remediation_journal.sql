CREATE UNIQUE INDEX "publication_attempts_workspace_id_unique" ON "publication_attempts" ("workspace_id", "id");
CREATE TABLE "x_remediation_journals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_job_id" uuid NOT NULL,
  "source_attempt_id" uuid NOT NULL,
  "source_external_post_id" text NOT NULL,
  "source_revision_id" uuid NOT NULL,
  "source_content_hash" text NOT NULL,
  "source_media_hashes" jsonb NOT NULL,
  "phase" text NOT NULL CHECK ("phase" IN ('prepared', 'deleted', 'replaced', 'verified')),
  "delete_confirmed_at" timestamp with time zone,
  "replacement_job_id" uuid,
  "replacement_attempt_id" uuid,
  "replacement_external_post_id" text,
  "replacement_external_url" text,
  "replacement_confirmed_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "x_remediation_journals_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  CONSTRAINT "x_remediation_journals_source_job_fk" FOREIGN KEY ("workspace_id", "source_job_id") REFERENCES "publication_jobs"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "x_remediation_journals_source_attempt_fk" FOREIGN KEY ("workspace_id", "source_attempt_id") REFERENCES "publication_attempts"("workspace_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "x_remediation_journals_source_job_unique" ON "x_remediation_journals" ("source_job_id");
CREATE INDEX "x_remediation_journals_workspace_phase_idx" ON "x_remediation_journals" ("workspace_id", "phase");
ALTER TABLE "x_remediation_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "x_remediation_journals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "x_remediation_journals_workspace_policy" ON "x_remediation_journals"
  USING ("workspace_id" = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true)::uuid);
