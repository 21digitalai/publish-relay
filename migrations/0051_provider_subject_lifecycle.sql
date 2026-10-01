ALTER TABLE "provider_connections"
  ADD COLUMN "external_subject_id" text,
  ADD COLUMN "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "access_expires_at" timestamptz,
  ADD COLUMN "refresh_expires_at" timestamptz,
  ADD COLUMN "last_refreshed_at" timestamptz,
  ADD COLUMN "revoked_at" timestamptz,
  ADD COLUMN "last_error_code" text;

UPDATE "provider_connections" AS connection
SET "external_subject_id" = COALESCE(
  connection."member_urn",
  (SELECT MIN(account."remote_account_id")
   FROM "provider_accounts" AS account
   WHERE account."connection_id" = connection."id"
     AND connection."provider" <> 'meta'
   HAVING COUNT(*) = 1),
  'legacy:' || connection."id"::text
);

ALTER TABLE "provider_connections"
  ALTER COLUMN "external_subject_id" SET DEFAULT 'legacy:' || gen_random_uuid()::text,
  ALTER COLUMN "external_subject_id" SET NOT NULL;

CREATE UNIQUE INDEX "provider_connections_workspace_subject_unique"
  ON "provider_connections" ("workspace_id", "provider", "external_subject_id");

DROP INDEX "provider_connections_workspace_provider_unique";
CREATE UNIQUE INDEX "provider_connections_workspace_provider_unique"
  ON "provider_connections" ("workspace_id", "provider")
  WHERE "provider" NOT IN ('linkedin', 'tiktok');
