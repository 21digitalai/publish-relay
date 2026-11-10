ALTER TABLE fanvue_dm_pending_intents
  ADD COLUMN target_label text;

ALTER TABLE fanvue_dm_pending_intents
  ADD CONSTRAINT fanvue_dm_pending_target_label_check
  CHECK (target_label IS NULL OR length(target_label) BETWEEN 1 AND 160);
