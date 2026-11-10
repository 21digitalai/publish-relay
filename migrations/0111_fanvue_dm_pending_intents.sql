CREATE TABLE fanvue_dm_pending_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  client_action_id uuid NOT NULL,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  text_body text,
  media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_cents integer,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_dm_pending_intents_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_dm_pending_intents_action_unique UNIQUE (workspace_id, client_action_id),
  CONSTRAINT fanvue_dm_pending_intents_status_check
    CHECK (status IN ('pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')),
  CONSTRAINT fanvue_dm_pending_intents_payload_check
    CHECK (jsonb_typeof(media_ids) = 'array' AND jsonb_array_length(media_ids) <= 10
      AND ((text_body IS NOT NULL AND length(text_body) BETWEEN 1 AND 5000) OR jsonb_array_length(media_ids) > 0)),
  CONSTRAINT fanvue_dm_pending_intents_price_check
    CHECK (price_cents IS NULL OR (price_cents >= 300 AND jsonb_array_length(media_ids) > 0)),
  CONSTRAINT fanvue_dm_pending_intents_lease_check
    CHECK ((status = 'claimed') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX fanvue_dm_pending_intents_due_idx ON fanvue_dm_pending_intents(due_at, id)
  WHERE status IN ('pending', 'claimed');
ALTER TABLE fanvue_dm_pending_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_pending_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_dm_pending_intents_workspace_policy ON fanvue_dm_pending_intents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

CREATE TABLE fanvue_dm_dispatch_pacing (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  next_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, account_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE fanvue_dm_dispatch_pacing ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_dispatch_pacing FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_dm_dispatch_pacing_workspace_policy ON fanvue_dm_dispatch_pacing
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
