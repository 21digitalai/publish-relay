CREATE TABLE engagement_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dm', 'comment')),
  target_id text NOT NULL,
  source_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  content jsonb NOT NULL,
  proposer_type text NOT NULL CHECK (proposer_type IN ('user', 'api_key', 'delegated')),
  proposer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'approved', 'sending', 'sent', 'unknown', 'failed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- Cursors serialize JavaScript Date values at millisecond precision. Keep the
  -- stored ordering key at that precision so pagination cannot skip rows.
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_proposals_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT engagement_proposals_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT engagement_proposals_source_object CHECK (jsonb_typeof(source_context) = 'object'),
  CONSTRAINT engagement_proposals_target_nonempty CHECK (length(trim(target_id)) > 0),
  CONSTRAINT engagement_proposals_provider_nonempty CHECK (length(trim(provider)) > 0),
  CONSTRAINT engagement_proposals_workspace_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT engagement_proposals_workspace_id_unique UNIQUE (workspace_id, id)
);
CREATE INDEX engagement_proposals_pending_idx ON engagement_proposals(workspace_id, created_at DESC)
  WHERE status = 'pending';
ALTER TABLE engagement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_proposals_workspace_policy ON engagement_proposals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
