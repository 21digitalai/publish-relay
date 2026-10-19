ALTER TABLE publication_attempts ADD COLUMN tiktok_init_phase text;
ALTER TABLE publication_attempts ADD COLUMN tiktok_media_grant_id uuid;
ALTER TABLE publication_attempts ADD CONSTRAINT publication_attempts_tiktok_phase_check
  CHECK (tiktok_init_phase IS NULL OR tiktok_init_phase IN ('init_sending', 'accepted_pending', 'outcome_unknown', 'failed'));
ALTER TABLE publication_attempts ADD CONSTRAINT publication_attempts_tiktok_grant_fk
  FOREIGN KEY (workspace_id, tiktok_media_grant_id)
  REFERENCES provider_media_grants(workspace_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX publication_attempts_tiktok_grant_unique
  ON publication_attempts(tiktok_media_grant_id) WHERE tiktok_media_grant_id IS NOT NULL;
