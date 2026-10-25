CREATE TABLE fanvue_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_fingerprint text NOT NULL,
  creator_uuid uuid NOT NULL,
  fan_uuid uuid NOT NULL,
  invoice_id text NOT NULL,
  source text NOT NULL,
  gross_minor integer NOT NULL,
  currency text,
  paid_at timestamptz,
  event_at timestamptz NOT NULL,
  post_uuid uuid,
  message_uuid uuid,
  tip_context text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_payment_receipts_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_payment_receipts_source_check
    CHECK (source IN ('post', 'message', 'media', 'tip', 'subscription')),
  CONSTRAINT fanvue_payment_receipts_amount_check CHECK (gross_minor >= 0),
  CONSTRAINT fanvue_payment_receipts_currency_check
    CHECK (currency IS NULL OR length(currency) = 3),
  CONSTRAINT fanvue_payment_receipts_tip_context_check
    CHECK (tip_context IS NULL OR tip_context IN ('post', 'message'))
);
CREATE UNIQUE INDEX fanvue_payment_receipts_event_unique
  ON fanvue_payment_receipts(workspace_id, account_id, event_id);
CREATE INDEX fanvue_payment_receipts_account_paid_idx
  ON fanvue_payment_receipts(workspace_id, account_id, event_at DESC, id DESC);
ALTER TABLE fanvue_payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_payment_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_payment_receipts_workspace_isolation ON fanvue_payment_receipts
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
