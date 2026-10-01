CREATE TABLE "provider_capability_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "external_subject_id" text NOT NULL,
  "credential_version" integer NOT NULL,
  "nickname" text NOT NULL,
  "privacy_options" jsonb NOT NULL,
  "comment_disabled" boolean NOT NULL,
  "duet_disabled" boolean NOT NULL,
  "stitch_disabled" boolean NOT NULL,
  "max_video_duration_seconds" integer NOT NULL,
  "provider_log_id" text,
  "fetched_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "provider_capability_snapshots_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "provider_accounts"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_capability_snapshots_workspace_connection_fk" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "provider_connections"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_capability_snapshots_duration_check" CHECK ("max_video_duration_seconds" > 0),
  CONSTRAINT "provider_capability_snapshots_expiry_check" CHECK ("expires_at" > "fetched_at")
);
CREATE INDEX "provider_capability_snapshots_account_fetched_idx" ON "provider_capability_snapshots" ("workspace_id", "account_id", "fetched_at");
CREATE INDEX "provider_capability_snapshots_expiry_idx" ON "provider_capability_snapshots" ("workspace_id", "expires_at");
ALTER TABLE "provider_capability_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_capability_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_capability_snapshots_workspace_policy" ON "provider_capability_snapshots"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
