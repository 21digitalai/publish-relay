ALTER TABLE facebook_page_dm_pending_intents
  ADD COLUMN pre_send_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE facebook_page_dm_pending_intents
  ADD CONSTRAINT facebook_page_dm_pending_intents_pre_send_attempts_check
  CHECK (pre_send_attempts BETWEEN 0 AND 3);
