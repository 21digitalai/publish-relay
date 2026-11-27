-- Forward-only repair. Existing rows and ledger entries are untouched.
-- Compare existing structure to a disposable exact definition; drift fails closed.
DO $repair$
BEGIN
  IF to_regclass('public.instagram_unified_dm_no_go') IS NULL THEN
CREATE TABLE instagram_unified_dm_no_go (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, conversation_id),
  CONSTRAINT instagram_unified_dm_no_go_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE instagram_unified_dm_no_go ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_unified_dm_no_go FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_dm_no_go_workspace_policy ON instagram_unified_dm_no_go
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

  END IF;
END
$repair$;
--> statement-breakpoint
CREATE SCHEMA _relay_0135_reference;
CREATE TABLE _relay_0135_reference.instagram_unified_dm_no_go (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  conversation_id text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, conversation_id),
  CONSTRAINT instagram_unified_dm_no_go_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE _relay_0135_reference.instagram_unified_dm_no_go ENABLE ROW LEVEL SECURITY;
ALTER TABLE _relay_0135_reference.instagram_unified_dm_no_go FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_dm_no_go_workspace_policy ON _relay_0135_reference.instagram_unified_dm_no_go
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

--> statement-breakpoint
DO $validate$
BEGIN
  IF (SELECT jsonb_agg(signature ORDER BY signature::text) FROM (
    SELECT jsonb_build_array('column',attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid)) signature
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.instagram_unified_dm_no_go'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT jsonb_build_array('constraint',contype,pg_get_constraintdef(oid),convalidated)
    FROM pg_constraint WHERE conrelid='public.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('index',indisunique,indisprimary,
      (SELECT jsonb_agg(pg_get_indexdef(indexrelid,k,true) ORDER BY k) FROM generate_series(1,indnatts) k),
      pg_get_expr(indpred,indrelid),indisvalid)
    FROM pg_index WHERE indrelid='public.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('policy',polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))
    FROM pg_policy WHERE polrelid='public.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('rls',relrowsecurity,relforcerowsecurity)
    FROM pg_class WHERE oid='public.instagram_unified_dm_no_go'::regclass
  ) signatures) IS DISTINCT FROM
     (SELECT jsonb_agg(signature ORDER BY signature::text) FROM (
    SELECT jsonb_build_array('column',attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid)) signature
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='_relay_0135_reference.instagram_unified_dm_no_go'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT jsonb_build_array('constraint',contype,pg_get_constraintdef(oid),convalidated)
    FROM pg_constraint WHERE conrelid='_relay_0135_reference.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('index',indisunique,indisprimary,
      (SELECT jsonb_agg(pg_get_indexdef(indexrelid,k,true) ORDER BY k) FROM generate_series(1,indnatts) k),
      pg_get_expr(indpred,indrelid),indisvalid)
    FROM pg_index WHERE indrelid='_relay_0135_reference.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('policy',polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))
    FROM pg_policy WHERE polrelid='_relay_0135_reference.instagram_unified_dm_no_go'::regclass
    UNION ALL SELECT jsonb_build_array('rls',relrowsecurity,relforcerowsecurity)
    FROM pg_class WHERE oid='_relay_0135_reference.instagram_unified_dm_no_go'::regclass
  ) signatures) THEN
    RAISE EXCEPTION 'Incompatible instagram_unified_dm_no_go schema; no data changed';
  END IF;
END
$validate$;
--> statement-breakpoint
DROP SCHEMA _relay_0135_reference CASCADE;
