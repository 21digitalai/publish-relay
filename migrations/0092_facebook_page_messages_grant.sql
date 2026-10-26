-- Bind verified Messenger consent to the exact selected Page credential.
-- A later publishing reconnect changes that credential and automatically makes
-- the old Messenger evidence ineligible until explicit reauthorization.
ALTER TABLE facebook_page_engagement_modules
  ADD COLUMN dms_credential_id uuid,
  ADD COLUMN dms_granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE facebook_page_engagement_modules
  ADD CONSTRAINT facebook_page_engagement_dms_credential_fk
  FOREIGN KEY (workspace_id, dms_credential_id)
  REFERENCES credentials(workspace_id, id) ON DELETE RESTRICT;

UPDATE facebook_page_engagement_modules
SET dms_provider_grant = 'unknown', dms_verified_at = NULL
WHERE dms_provider_grant = 'verified';

ALTER TABLE facebook_page_engagement_modules
  DROP CONSTRAINT facebook_page_engagement_dms_evidence_check;
ALTER TABLE facebook_page_engagement_modules
  ADD CONSTRAINT facebook_page_engagement_dms_evidence_check
  CHECK ((dms_provider_grant = 'verified') =
    (dms_verified_at IS NOT NULL AND dms_credential_id IS NOT NULL));
