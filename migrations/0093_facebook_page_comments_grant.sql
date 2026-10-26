-- Bind optional Comments consent to its own selected Page credential.
-- Publishing and Messenger credentials remain untouched by this migration.
ALTER TABLE facebook_page_engagement_modules
  ADD COLUMN comments_credential_id uuid,
  ADD COLUMN comments_granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE facebook_page_engagement_modules
  ADD CONSTRAINT facebook_page_engagement_comments_credential_fk
  FOREIGN KEY (workspace_id, comments_credential_id)
  REFERENCES credentials(workspace_id, id) ON DELETE RESTRICT;

UPDATE facebook_page_engagement_modules
SET comments_provider_grant = 'unknown', comments_verified_at = NULL
WHERE comments_provider_grant = 'verified';

ALTER TABLE facebook_page_engagement_modules
  DROP CONSTRAINT facebook_page_engagement_comments_evidence_check;
ALTER TABLE facebook_page_engagement_modules
  ADD CONSTRAINT facebook_page_engagement_comments_evidence_check
  CHECK ((comments_provider_grant = 'verified') =
    (comments_verified_at IS NOT NULL AND comments_credential_id IS NOT NULL));
