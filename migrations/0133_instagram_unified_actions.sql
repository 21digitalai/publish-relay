-- Forward-only repair. Existing rows and ledger entries are untouched.
-- Compare existing structure to a disposable exact definition; drift fails closed.
DO $repair$
BEGIN
  IF to_regclass('public.instagram_unified_actions') IS NULL THEN
CREATE TABLE instagram_unified_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_reply', 'dm_reply')),
  target_id text NOT NULL,
  parent_id text NOT NULL,
  recipient_id text,
  text_body text NOT NULL CHECK (length(trim(text_body)) BETWEEN 1 AND 2000),
  request_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'confirmed', 'failed', 'unknown')),
  provider_receipt text,
  failure_status integer,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_unified_actions_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX instagram_unified_actions_workspace_action_unique
  ON instagram_unified_actions(workspace_id, client_action_id);
ALTER TABLE instagram_unified_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_unified_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_actions_workspace_isolation ON instagram_unified_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

  END IF;
END
$repair$;
--> statement-breakpoint
CREATE SCHEMA _relay_0133_reference;
CREATE TABLE _relay_0133_reference.instagram_unified_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment_reply', 'dm_reply')),
  target_id text NOT NULL,
  parent_id text NOT NULL,
  recipient_id text,
  text_body text NOT NULL CHECK (length(trim(text_body)) BETWEEN 1 AND 2000),
  request_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'confirmed', 'failed', 'unknown')),
  provider_receipt text,
  failure_status integer,
  actor_type audit_actor_type NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_unified_actions_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES provider_accounts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX instagram_unified_actions_workspace_action_unique
  ON _relay_0133_reference.instagram_unified_actions(workspace_id, client_action_id);
ALTER TABLE _relay_0133_reference.instagram_unified_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE _relay_0133_reference.instagram_unified_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY instagram_unified_actions_workspace_isolation ON _relay_0133_reference.instagram_unified_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

--> statement-breakpoint
DO $validate$
BEGIN
  IF (SELECT jsonb_agg(signature ORDER BY signature::text) FROM (
    SELECT jsonb_build_array('column',attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid)) signature
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.instagram_unified_actions'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT jsonb_build_array('constraint',contype,pg_get_constraintdef(oid),convalidated)
    FROM pg_constraint WHERE conrelid='public.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('index',indisunique,indisprimary,
      (SELECT jsonb_agg(pg_get_indexdef(indexrelid,k,true) ORDER BY k) FROM generate_series(1,indnatts) k),
      pg_get_expr(indpred,indrelid),indisvalid)
    FROM pg_index WHERE indrelid='public.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('policy',polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))
    FROM pg_policy WHERE polrelid='public.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('rls',relrowsecurity,relforcerowsecurity)
    FROM pg_class WHERE oid='public.instagram_unified_actions'::regclass
  ) signatures) IS DISTINCT FROM
     (SELECT jsonb_agg(signature ORDER BY signature::text) FROM (
    SELECT jsonb_build_array('column',attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid)) signature
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='_relay_0133_reference.instagram_unified_actions'::regclass AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT jsonb_build_array('constraint',contype,pg_get_constraintdef(oid),convalidated)
    FROM pg_constraint WHERE conrelid='_relay_0133_reference.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('index',indisunique,indisprimary,
      (SELECT jsonb_agg(pg_get_indexdef(indexrelid,k,true) ORDER BY k) FROM generate_series(1,indnatts) k),
      pg_get_expr(indpred,indrelid),indisvalid)
    FROM pg_index WHERE indrelid='_relay_0133_reference.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('policy',polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid))
    FROM pg_policy WHERE polrelid='_relay_0133_reference.instagram_unified_actions'::regclass
    UNION ALL SELECT jsonb_build_array('rls',relrowsecurity,relforcerowsecurity)
    FROM pg_class WHERE oid='_relay_0133_reference.instagram_unified_actions'::regclass
  ) signatures) THEN
    RAISE EXCEPTION 'Incompatible instagram_unified_actions schema; no data changed';
  END IF;
END
$validate$;
--> statement-breakpoint
DROP SCHEMA _relay_0133_reference CASCADE;
