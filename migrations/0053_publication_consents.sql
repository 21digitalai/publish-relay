CREATE UNIQUE INDEX "provider_capability_snapshots_workspace_id_unique"
  ON "provider_capability_snapshots" ("workspace_id", "id");
CREATE TABLE "publication_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "post_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "media_id" uuid NOT NULL,
  "media_sha256" text NOT NULL,
  "capability_snapshot_id" uuid NOT NULL,
  "credential_version" integer NOT NULL,
  "declaration_version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "consented_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "publication_consents_workspace_post_fk" FOREIGN KEY ("workspace_id", "post_id") REFERENCES "posts"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "publication_consents_workspace_revision_fk" FOREIGN KEY ("workspace_id", "revision_id") REFERENCES "post_revisions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "publication_consents_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "provider_accounts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "publication_consents_workspace_media_fk" FOREIGN KEY ("workspace_id", "media_id") REFERENCES "media_objects"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "publication_consents_workspace_snapshot_fk" FOREIGN KEY ("workspace_id", "capability_snapshot_id") REFERENCES "provider_capability_snapshots"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "publication_consents_media_hash_check" CHECK ("media_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "publication_consents_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "publication_consents_workspace_id_unique" ON "publication_consents" ("workspace_id", "id");
CREATE INDEX "publication_consents_revision_idx" ON "publication_consents" ("workspace_id", "revision_id");
ALTER TABLE "publication_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publication_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "publication_consents_workspace_policy" ON "publication_consents"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE TRIGGER "publication_consents_append_only" BEFORE UPDATE OR DELETE ON "publication_consents"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_mutation"();
