ALTER TABLE "provider_accounts" ADD COLUMN "destination_provider" text;
ALTER TABLE "provider_accounts" ADD COLUMN "remote_account_id" text;
ALTER TABLE "provider_accounts" ADD COLUMN "remote_parent_account_id" text;
ALTER TABLE "provider_accounts" ADD COLUMN "credential_id" uuid;
ALTER TABLE "provider_accounts" ADD COLUMN "capability_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "provider_accounts" ADD COLUMN "capabilities_checked_at" timestamp with time zone;
ALTER TABLE "provider_accounts" ADD COLUMN "availability" text DEFAULT 'active' NOT NULL;

UPDATE "provider_accounts" AS account
SET "destination_provider" = connection."provider",
    "remote_account_id" = account."provider_account_id"
FROM "provider_connections" AS connection
WHERE connection."id" = account."connection_id"
  AND connection."workspace_id" = account."workspace_id"
  AND connection."provider" IN ('x', 'youtube');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "provider_accounts"
    WHERE "destination_provider" IS NULL OR "remote_account_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'provider account backfill supports only explicit x/youtube connections';
  END IF;
END $$;

ALTER TABLE "provider_accounts" ALTER COLUMN "destination_provider" SET NOT NULL;
ALTER TABLE "provider_accounts" ALTER COLUMN "remote_account_id" SET NOT NULL;
DROP INDEX "provider_accounts_connection_external_unique";
CREATE UNIQUE INDEX "provider_connections_workspace_id_unique"
  ON "provider_connections" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "credentials_workspace_id_unique"
  ON "credentials" ("workspace_id", "id");
CREATE UNIQUE INDEX "provider_accounts_connection_destination_remote_unique"
  ON "provider_accounts" ("connection_id", "destination_provider", "remote_account_id");
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_availability_check"
  CHECK ("availability" IN ('active', 'reauth_required', 'permission_lost', 'remote_missing'));
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_workspace_connection_fk"
  FOREIGN KEY ("workspace_id", "connection_id")
  REFERENCES "provider_connections" ("workspace_id", "id") ON DELETE CASCADE;
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_workspace_credential_fk"
  FOREIGN KEY ("workspace_id", "credential_id")
  REFERENCES "credentials" ("workspace_id", "id") ON DELETE RESTRICT;
