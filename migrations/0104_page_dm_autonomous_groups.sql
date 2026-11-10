ALTER TABLE facebook_page_dm_pending_intents
  DROP CONSTRAINT facebook_page_dm_pending_intents_group_check,
  ADD CONSTRAINT facebook_page_dm_pending_intents_group_check
    CHECK ((group_id IS NULL AND sequence_index IS NULL AND gap_seconds IS NULL)
      OR (group_id IS NOT NULL AND sequence_index BETWEEN 0 AND 3
        AND gap_seconds BETWEEN 0 AND 10 AND expected_latest_inbound_message_id IS NOT NULL));

CREATE TABLE facebook_page_dm_dispatch_pacing (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  next_root_at timestamptz NOT NULL,
  last_root_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, account_id),
  CONSTRAINT facebook_page_dm_dispatch_pacing_account_fk
    FOREIGN KEY (workspace_id, account_id) REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE facebook_page_dm_dispatch_pacing ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_dm_dispatch_pacing FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_dm_dispatch_pacing_workspace_policy ON facebook_page_dm_dispatch_pacing
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
