-- Local Page modules are independent of Meta's provider grant. An absent row is
-- disabled with unknown provider evidence. Cross-workspace exposures confer no access.
CREATE TABLE facebook_page_engagement_modules (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  comments_enabled boolean NOT NULL DEFAULT false,
  dms_enabled boolean NOT NULL DEFAULT false,
  comments_provider_grant text NOT NULL DEFAULT 'unknown',
  dms_provider_grant text NOT NULL DEFAULT 'unknown',
  comments_verified_at timestamptz,
  dms_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id),
  CONSTRAINT facebook_page_engagement_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_engagement_comments_grant_check
    CHECK (comments_provider_grant IN ('unknown', 'missing', 'verified')),
  CONSTRAINT facebook_page_engagement_dms_grant_check
    CHECK (dms_provider_grant IN ('unknown', 'missing', 'verified')),
  CONSTRAINT facebook_page_engagement_comments_evidence_check
    CHECK ((comments_provider_grant = 'verified') = (comments_verified_at IS NOT NULL)),
  CONSTRAINT facebook_page_engagement_dms_evidence_check
    CHECK ((dms_provider_grant = 'verified') = (dms_verified_at IS NOT NULL))
);

-- A Page grant belongs to exactly one credential. Legacy keys and delegated
-- grants have no rows, so adding new tool routes cannot silently empower them.
CREATE TABLE facebook_page_engagement_grants (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  api_key_id uuid,
  delegated_grant_id uuid,
  capability text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facebook_page_engagement_principal_check
    CHECK ((api_key_id IS NOT NULL) <> (delegated_grant_id IS NOT NULL)),
  CONSTRAINT facebook_page_engagement_capability_check
    CHECK (capability IN (
      'comments:read', 'comments:propose', 'comments:send',
      'dms:read', 'dms:propose', 'dms:send'
    )),
  CONSTRAINT facebook_page_engagement_grants_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES facebook_page_engagement_modules(workspace_id, account_id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_engagement_grants_api_key_fk
    FOREIGN KEY (workspace_id, api_key_id)
    REFERENCES api_keys(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT facebook_page_engagement_grants_delegated_fk
    FOREIGN KEY (workspace_id, delegated_grant_id)
    REFERENCES delegated_grants(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX facebook_page_engagement_api_key_grant_unique
  ON facebook_page_engagement_grants(workspace_id, account_id, api_key_id, capability)
  WHERE api_key_id IS NOT NULL;
CREATE UNIQUE INDEX facebook_page_engagement_delegated_grant_unique
  ON facebook_page_engagement_grants(workspace_id, account_id, delegated_grant_id, capability)
  WHERE delegated_grant_id IS NOT NULL;

ALTER TABLE facebook_page_engagement_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_engagement_modules FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_engagement_modules_workspace_policy ON facebook_page_engagement_modules
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE facebook_page_engagement_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_page_engagement_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_page_engagement_grants_workspace_policy ON facebook_page_engagement_grants
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
