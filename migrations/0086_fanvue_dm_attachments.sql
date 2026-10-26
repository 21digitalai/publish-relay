CREATE TABLE fanvue_dm_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  media_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'bound',
  provider_media_uuid uuid,
  upload_credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fanvue_dm_attachments_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_dm_attachments_media_fk FOREIGN KEY (workspace_id, media_id)
    REFERENCES media_objects(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_dm_attachments_upload_credential_fk FOREIGN KEY (workspace_id, upload_credential_id)
    REFERENCES credentials(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fanvue_dm_attachments_state_check
    CHECK (state IN ('bound', 'uploading', 'unknown', 'ready', 'failed', 'released')),
  CONSTRAINT fanvue_dm_attachments_ready_check
    CHECK (state <> 'ready' OR provider_media_uuid IS NOT NULL)
);
CREATE UNIQUE INDEX fanvue_dm_attachments_action_media_unique
  ON fanvue_dm_attachments(workspace_id, account_id, client_action_id, media_id);
CREATE INDEX fanvue_dm_attachments_media_active_idx
  ON fanvue_dm_attachments(workspace_id, media_id) WHERE state <> 'released';
ALTER TABLE fanvue_dm_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fanvue_dm_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY fanvue_dm_attachments_workspace_policy ON fanvue_dm_attachments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
