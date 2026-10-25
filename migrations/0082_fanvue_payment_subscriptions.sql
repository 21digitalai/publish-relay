CREATE TABLE fanvue_payment_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  creator_uuid uuid NOT NULL,
  callback_handle_hash text NOT NULL,
  provider_subscription_id text,
  signing_credential_id uuid,
  state text NOT NULL DEFAULT 'probe_pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_payment_subscriptions_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_payment_subscriptions_signing_credential_fk
    FOREIGN KEY (workspace_id, signing_credential_id)
    REFERENCES credentials(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_payment_subscriptions_state_check
    CHECK (state IN ('probe_pending', 'creation_unknown', 'active', 'disabled')),
  CONSTRAINT fanvue_payment_subscriptions_handle_hash_check
    CHECK (callback_handle_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT fanvue_payment_subscriptions_active_fields_check
    CHECK (state <> 'active' OR (provider_subscription_id IS NOT NULL AND signing_credential_id IS NOT NULL))
);
CREATE UNIQUE INDEX fanvue_payment_subscriptions_handle_unique
  ON fanvue_payment_subscriptions(callback_handle_hash);
CREATE UNIQUE INDEX fanvue_payment_subscriptions_account_open_unique
  ON fanvue_payment_subscriptions(workspace_id, account_id) WHERE state <> 'disabled';
ALTER TABLE fanvue_payment_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_payment_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_payment_subscriptions_workspace_policy ON fanvue_payment_subscriptions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
