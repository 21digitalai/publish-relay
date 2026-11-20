CREATE TABLE fanvue_vault_media_prices (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider_media_uuid uuid NOT NULL,
  manual_price_cents integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, provider_media_uuid),
  CONSTRAINT fanvue_vault_media_prices_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_vault_media_prices_positive_price_check
    CHECK (manual_price_cents IS NULL OR manual_price_cents > 0),
  CONSTRAINT fanvue_vault_media_prices_positive_version_check CHECK (version > 0)
);

ALTER TABLE fanvue_vault_media_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_vault_media_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_vault_media_prices_workspace_policy ON fanvue_vault_media_prices
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
