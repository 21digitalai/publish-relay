ALTER TABLE fanvue_dm_conversation_state
  ADD COLUMN history_backfill_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN history_backfill_failure_code text,
  ADD COLUMN history_backfill_last_attempt_at timestamptz,
  ADD CONSTRAINT fanvue_dm_conversation_state_history_status_check CHECK (
    history_backfill_status IN ('not_started', 'in_progress', 'incomplete', 'complete')
  );
