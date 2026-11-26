CREATE TABLE instagram_unified_dm_no_go (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, conversation_id),
  CONSTRAINT instagram_unified_dm_no_go_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE instagram_unified_dm_no_go ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_unified_dm_no_go FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_dm_no_go_workspace_policy ON instagram_unified_dm_no_go
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
