CREATE TABLE "provider_media_grants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "media_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "media_sha256" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_media_grants_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "provider_accounts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_media_grants_workspace_media_fk" FOREIGN KEY ("workspace_id", "media_id") REFERENCES "media_objects"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_media_grants_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "provider_media_grants_media_hash_check" CHECK ("media_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "provider_media_grants_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "provider_media_grants_expiry_check" CHECK ("expires_at" >= "created_at" + interval '90 minutes')
);
CREATE UNIQUE INDEX "provider_media_grants_workspace_id_unique" ON "provider_media_grants" ("workspace_id", "id");
CREATE UNIQUE INDEX "provider_media_grants_token_hash_unique" ON "provider_media_grants" ("token_hash");
CREATE INDEX "provider_media_grants_media_expiry_idx" ON "provider_media_grants" ("workspace_id", "media_id", "expires_at");
ALTER TABLE "provider_media_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_media_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_media_grants_workspace_policy" ON "provider_media_grants"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
