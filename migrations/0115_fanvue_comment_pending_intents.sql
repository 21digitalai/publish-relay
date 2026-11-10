CREATE TABLE fanvue_comment_pending_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  post_uuid uuid NOT NULL,
  client_action_id uuid NOT NULL,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  text_body text NOT NULL,
  target_label text,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_comment_pending_intents_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_comment_pending_intents_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT fanvue_comment_pending_intents_status_check
    CHECK (status IN ('pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  CONSTRAINT fanvue_comment_pending_intents_text_check CHECK (length(text_body) BETWEEN 1 AND 600),
  CONSTRAINT fanvue_comment_pending_intents_lease_check
    CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX fanvue_comment_pending_intents_due_idx ON fanvue_comment_pending_intents(due_at, id)
  WHERE status IN ('pending', 'claimed');
ALTER TABLE fanvue_comment_pending_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_comment_pending_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_comment_pending_intents_workspace_policy ON fanvue_comment_pending_intents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
