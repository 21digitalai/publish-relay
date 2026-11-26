CREATE TABLE instagram_unified_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_reply', 'dm_reply')),
  target_id text NOT NULL,
  parent_id text NOT NULL,
  recipient_id text,
  text_body text NOT NULL CHECK (length(trim(text_body)) BETWEEN 1 AND 2000),
  request_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'confirmed', 'failed', 'unknown')),
  provider_receipt text,
  failure_status integer,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_unified_actions_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX instagram_unified_actions_workspace_action_unique
  ON instagram_unified_actions(workspace_id, client_action_id);
ALTER TABLE instagram_unified_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_unified_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_actions_workspace_isolation ON instagram_unified_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
