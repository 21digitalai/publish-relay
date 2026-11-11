CREATE TABLE facebook_page_dm_active_days (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  civil_day text NOT NULL,
  inbound_message_id text NOT NULL,
  inbound_at timestamptz NOT NULL,
  outbound_action_id uuid NOT NULL,
  outbound_message_id text NOT NULL,
  outbound_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, account_id, conversation_id, civil_day),
  CONSTRAINT facebook_page_dm_active_days_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_dm_active_days_day_check CHECK (civil_day ~ '^\d{4}-\d{2}-\d{2}$')
);
ALTER TABLE facebook_page_dm_active_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_dm_active_days FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_dm_active_days_workspace_policy ON facebook_page_dm_active_days
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
