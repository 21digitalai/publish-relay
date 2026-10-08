ALTER TABLE "provider_connections"
  ADD COLUMN "grant_family" text;

ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_meta_grant_family_valid"
  CHECK ("grant_family" IS NULL OR ("provider" = 'meta' AND "grant_family" IN ('facebook_pages', 'instagram')));

DROP INDEX "provider_connections_workspace_subject_unique";
CREATE UNIQUE INDEX "provider_connections_workspace_subject_unique"
  ON "provider_connections" ("workspace_id", "provider", "external_subject_id", COALESCE("grant_family", 'legacy'));

-- A combined legacy grant cannot silently authorize either new family. Keep all account and
-- job identifiers intact; explicit new consent may later rehome each destination family.
UPDATE "provider_accounts" AS account
SET "availability" = 'reauth_required', "updated_at" = NOW()
FROM "provider_connections" AS connection
WHERE account."connection_id" = connection."id"
  AND account."workspace_id" = connection."workspace_id"
  AND connection."provider" = 'meta'
  AND connection."grant_family" IS NULL
  AND account."disconnected_at" IS NULL;

UPDATE "provider_connections"
SET "status" = 'disconnected', "updated_at" = NOW()
WHERE "provider" = 'meta' AND "grant_family" IS NULL AND "status" = 'active';
