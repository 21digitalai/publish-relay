ALTER TABLE fanvue_dm_attachments
  DROP CONSTRAINT fanvue_dm_attachments_state_check;

ALTER TABLE fanvue_dm_attachments
  ADD CONSTRAINT fanvue_dm_attachments_state_check
    CHECK (state IN ('bound', 'uploading', 'unknown', 'processing', 'ready', 'failed', 'released'));
