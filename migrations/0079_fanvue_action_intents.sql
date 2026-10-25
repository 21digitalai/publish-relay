CREATE TABLE fanvue_action_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  action_kind text NOT NULL,
  target_uuid uuid NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  provider_object_uuid uuid,
  failure_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_action_intents_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_action_intents_kind_check CHECK (action_kind IN ('message', 'comment')),
  CONSTRAINT fanvue_action_intents_state_check CHECK (state IN ('reserved', 'confirmed', 'failed', 'unknown')),
  CONSTRAINT fanvue_action_intents_result_check CHECK (
    (state = 'confirmed' AND provider_object_uuid IS NOT NULL AND failure_status IS NULL)
    OR (state = 'failed' AND provider_object_uuid IS NULL AND failure_status BETWEEN 400 AND 499)
    OR (state IN ('reserved', 'unknown') AND provider_object_uuid IS NULL AND failure_status IS NULL)
  )
);
CREATE UNIQUE INDEX fanvue_action_intents_action_unique
  ON fanvue_action_intents(workspace_id, account_id, client_action_id);
CREATE INDEX fanvue_action_intents_account_created_idx
  ON fanvue_action_intents(workspace_id, account_id, created_at);
ALTER TABLE fanvue_action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_action_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_action_intents_workspace_isolation ON fanvue_action_intents
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
