CREATE TABLE facebook_page_dm_pending_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  client_action_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  text_body text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facebook_page_dm_pending_intents_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT facebook_page_dm_pending_intents_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT facebook_page_dm_pending_intents_status_check
    CHECK (status IN ('pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  CONSTRAINT facebook_page_dm_pending_intents_text_check
    CHECK (length(trim(text_body)) BETWEEN 1 AND 2000),
  CONSTRAINT facebook_page_dm_pending_intents_lease_check
    CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX facebook_page_dm_pending_intents_due_idx
  ON facebook_page_dm_pending_intents(due_at, id)
  WHERE status IN ('pending', 'claimed');
ALTER TABLE facebook_page_dm_pending_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_dm_pending_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_dm_pending_intents_workspace_policy ON facebook_page_dm_pending_intents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE engagement_proposals DROP CONSTRAINT IF EXISTS engagement_proposals_status_check;
ALTER TABLE engagement_proposals ADD CONSTRAINT engagement_proposals_status_check
  CHECK (status IN ('pending', 'dismissed', 'approved', 'sending', 'scheduled', 'cancelled', 'sent', 'unknown', 'failed'));
