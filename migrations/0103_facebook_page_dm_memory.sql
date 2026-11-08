CREATE TABLE facebook_page_dm_memory (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_contact_at timestamptz,
  last_processed_inbound_id text,
  last_outbound_receipt_ref text,
  terminal boolean NOT NULL DEFAULT false,
  unanswered_follow_up boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, conversation_id),
  CONSTRAINT facebook_page_dm_memory_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_dm_memory_facts_check CHECK (jsonb_typeof(facts) = 'array')
);
ALTER TABLE facebook_page_dm_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_dm_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_dm_memory_workspace_policy ON facebook_page_dm_memory
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
