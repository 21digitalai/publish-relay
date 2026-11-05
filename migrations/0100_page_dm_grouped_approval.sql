ALTER TABLE facebook_page_dm_pending_intents
  ADD COLUMN group_id uuid,
  ADD COLUMN sequence_index integer,
  ADD COLUMN gap_seconds integer,
  ADD COLUMN expected_latest_inbound_message_id text;

ALTER TABLE facebook_page_dm_pending_intents
  DROP CONSTRAINT facebook_page_dm_pending_intents_status_check,
  ADD CONSTRAINT facebook_page_dm_pending_intents_status_check
    CHECK (status IN ('waiting', 'pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  ADD CONSTRAINT facebook_page_dm_pending_intents_group_check
    CHECK ((group_id IS NULL AND sequence_index IS NULL AND gap_seconds IS NULL)
      OR (group_id IS NOT NULL AND sequence_index BETWEEN 0 AND 2
        AND gap_seconds BETWEEN 0 AND 10 AND expected_latest_inbound_message_id IS NOT NULL));

CREATE UNIQUE INDEX facebook_page_dm_pending_intents_group_sequence_unique
  ON facebook_page_dm_pending_intents (workspace_id, group_id, sequence_index);
