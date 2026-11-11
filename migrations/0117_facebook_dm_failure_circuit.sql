CREATE TABLE facebook_page_dm_failure_circuit (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  halted_at timestamptz,
  last_action_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id),
  CONSTRAINT facebook_page_dm_failure_circuit_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_dm_failure_circuit_count_check CHECK (consecutive_failures >= 0)
);
ALTER TABLE facebook_page_dm_failure_circuit ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_dm_failure_circuit FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_dm_failure_circuit_workspace_policy ON facebook_page_dm_failure_circuit
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
