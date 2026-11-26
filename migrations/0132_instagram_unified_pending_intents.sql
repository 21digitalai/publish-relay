CREATE TABLE instagram_unified_pending_intents (
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
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  target_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','cancelled','confirmed','failed','unknown','expired')),
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_unified_pending_intents_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT instagram_unified_pending_intents_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT instagram_unified_pending_intents_lease_check CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX instagram_unified_pending_intents_due_idx ON instagram_unified_pending_intents(due_at, id) WHERE status IN ('pending','claimed');
ALTER TABLE instagram_unified_pending_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_unified_pending_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_pending_intents_workspace_policy ON instagram_unified_pending_intents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
