CREATE TABLE fanvue_dm_conversation_state (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  latest_observed_message_uuid uuid,
  latest_observed_at timestamptz,
  latest_observed_direction text,
  latest_inbound_message_uuid uuid,
  latest_inbound_at timestamptz,
  latest_outbound_message_uuid uuid,
  latest_outbound_at timestamptz,
  last_processed_inbound_uuid uuid,
  last_processed_inbound_at timestamptz,
  provider_is_read boolean,
  provider_unread_count integer,
  last_chat_list_seen_at timestamptz,
  logical_exchange_count integer NOT NULL DEFAULT 0,
  active_day_count integer NOT NULL DEFAULT 0,
  next_review_at timestamptz,
  quiet_until_inbound_after_uuid uuid,
  history_coverage_oldest_at timestamptz,
  history_backfill_complete_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, fan_uuid),
  CONSTRAINT fanvue_dm_conversation_state_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_dm_conversation_state_direction_check CHECK (
    latest_observed_direction IS NULL OR latest_observed_direction IN ('inbound', 'outbound')
  ),
  CONSTRAINT fanvue_dm_conversation_state_counts_check CHECK (
    logical_exchange_count >= 0 AND active_day_count >= 0
    AND (provider_unread_count IS NULL OR provider_unread_count >= 0)
  )
);
CREATE INDEX fanvue_dm_conversation_state_due_idx
  ON fanvue_dm_conversation_state(workspace_id, account_id, next_review_at);

CREATE TABLE fanvue_dm_message_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  provider_message_uuid uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at timestamptz NOT NULL,
  media_uuids jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  purchased_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_dm_message_receipts_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX fanvue_dm_message_receipts_provider_unique
  ON fanvue_dm_message_receipts(workspace_id, account_id, provider_message_uuid);
CREATE INDEX fanvue_dm_message_receipts_fan_sent_idx
  ON fanvue_dm_message_receipts(workspace_id, account_id, fan_uuid, sent_at);

CREATE TABLE fanvue_dm_conversation_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('welcome', 'silent_followup', 'free_gift', 'paid_offer')),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  client_action_id uuid NOT NULL,
  group_id uuid,
  state text NOT NULL CHECK (state IN ('pending', 'confirmed', 'unknown', 'cancelled')),
  provider_message_uuid uuid,
  provider_media_uuid uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_dm_conversation_checkpoints_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX fanvue_dm_conversation_checkpoints_kind_unique
  ON fanvue_dm_conversation_checkpoints(workspace_id, account_id, fan_uuid, kind, ordinal);

CREATE TABLE fanvue_dm_media_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  provider_media_uuid uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('relay_action', 'provider_history')),
  client_action_id uuid,
  provider_message_uuid uuid,
  state text NOT NULL CHECK (state IN ('reserved', 'confirmed', 'unknown', 'cancelled')),
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  purchased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_dm_media_deliveries_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX fanvue_dm_media_deliveries_active_unique
  ON fanvue_dm_media_deliveries(workspace_id, account_id, fan_uuid, provider_media_uuid)
  WHERE state IN ('reserved', 'confirmed', 'unknown');
CREATE INDEX fanvue_dm_media_deliveries_fan_idx
  ON fanvue_dm_media_deliveries(workspace_id, account_id, fan_uuid, created_at);

ALTER TABLE fanvue_dm_conversation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_conversation_state FORCE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_message_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_conversation_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_conversation_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_media_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_media_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY fanvue_dm_conversation_state_workspace_policy ON fanvue_dm_conversation_state
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY fanvue_dm_message_receipts_workspace_policy ON fanvue_dm_message_receipts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY fanvue_dm_conversation_checkpoints_workspace_policy ON fanvue_dm_conversation_checkpoints
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY fanvue_dm_media_deliveries_workspace_policy ON fanvue_dm_media_deliveries
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
