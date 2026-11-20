ALTER TABLE fanvue_dm_pending_intents
  DROP CONSTRAINT fanvue_dm_pending_intents_status_check,
  ADD COLUMN group_id uuid,
  ADD COLUMN sequence_index integer,
  ADD COLUMN gap_seconds integer,
  ADD COLUMN expected_latest_inbound_message_uuid uuid,
  ADD COLUMN expected_latest_inbound_at timestamptz,
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT fanvue_dm_pending_intents_status_check
    CHECK (status IN ('waiting', 'pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  ADD CONSTRAINT fanvue_dm_pending_intents_group_shape_check CHECK (
    (group_id IS NULL AND sequence_index IS NULL AND gap_seconds IS NULL
      AND expected_latest_inbound_message_uuid IS NULL AND expected_latest_inbound_at IS NULL
      AND request_fingerprint IS NULL)
    OR
    (group_id IS NOT NULL AND sequence_index BETWEEN 0 AND 4
      AND gap_seconds BETWEEN 0 AND 10
      AND (sequence_index <> 0 OR gap_seconds = 0)
      AND expected_latest_inbound_message_uuid IS NOT NULL
      AND expected_latest_inbound_at IS NOT NULL
      AND request_fingerprint IS NOT NULL)
  );

CREATE UNIQUE INDEX fanvue_dm_pending_intents_group_sequence_unique
  ON fanvue_dm_pending_intents(workspace_id, group_id, sequence_index)
  WHERE group_id IS NOT NULL;
