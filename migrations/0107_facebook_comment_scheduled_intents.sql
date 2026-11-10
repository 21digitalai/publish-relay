ALTER TABLE facebook_page_comment_actions
  ADD COLUMN post_id text,
  ADD COLUMN text_body text;

CREATE TABLE facebook_page_comment_pending_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  post_id text NOT NULL,
  comment_id text NOT NULL,
  client_action_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  text_body text NOT NULL,
  target_text text NOT NULL,
  target_created_at text NOT NULL,
  thread_fingerprint text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  pre_send_attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facebook_page_comment_pending_intents_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT facebook_page_comment_pending_intents_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT facebook_page_comment_pending_intents_status_check
    CHECK (status IN ('pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  CONSTRAINT facebook_page_comment_pending_intents_text_check
    CHECK (length(trim(text_body)) BETWEEN 1 AND 2000),
  CONSTRAINT facebook_page_comment_pending_intents_lease_check
    CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX facebook_page_comment_pending_intents_active_comment_unique
  ON facebook_page_comment_pending_intents(workspace_id, account_id, comment_id)
  WHERE status IN ('pending', 'claimed', 'confirmed', 'unknown');
CREATE INDEX facebook_page_comment_pending_intents_due_idx
  ON facebook_page_comment_pending_intents(due_at, id)
  WHERE status IN ('pending', 'claimed');
ALTER TABLE facebook_page_comment_pending_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_comment_pending_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_comment_pending_intents_workspace_policy ON facebook_page_comment_pending_intents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE TABLE facebook_page_comment_dispatch_pacing (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  next_at timestamptz NOT NULL,
  last_intent_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, account_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE facebook_page_comment_dispatch_pacing ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_comment_dispatch_pacing FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_comment_dispatch_pacing_workspace_policy ON facebook_page_comment_dispatch_pacing
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
