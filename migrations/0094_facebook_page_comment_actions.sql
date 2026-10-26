CREATE TABLE facebook_page_comment_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  comment_id text NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  provider_comment_id text,
  failure_status integer,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facebook_page_comment_actions_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT facebook_page_comment_actions_state_check
    CHECK (state IN ('reserved', 'confirmed', 'failed', 'unknown'))
);
CREATE UNIQUE INDEX facebook_page_comment_actions_workspace_action_unique
  ON facebook_page_comment_actions(workspace_id, client_action_id);
ALTER TABLE facebook_page_comment_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_comment_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_comment_actions_workspace_policy ON facebook_page_comment_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
