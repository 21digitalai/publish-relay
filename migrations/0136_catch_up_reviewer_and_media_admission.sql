-- Forward-only convergence for installations that applied Unified migrations
-- before the older reviewer/media migrations entered their source history.
-- Historical SQL and ledger rows are deliberately left unchanged.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS review_access_expires_at timestamptz;
--> statement-breakpoint
DO $catchup$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='public.users'::regclass AND attname='review_access_expires_at'
      AND atttypid='timestamptz'::regtype AND NOT attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Incompatible users.review_access_expires_at column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.users'::regclass AND conname='users_review_access_requires_password') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_review_access_requires_password
      CHECK (review_access_expires_at IS NULL OR password_hash IS NOT NULL);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.users'::regclass AND conname='users_review_access_requires_password'
      AND contype='c' AND convalidated
      AND regexp_replace(lower(pg_get_expr(conbin,conrelid)), '[[:space:]()]', '', 'g')
          = 'review_access_expires_atisnullorpassword_hashisnotnull') THEN
    RAISE EXCEPTION 'Incompatible users_review_access_requires_password constraint';
  END IF;
END
$catchup$;
--> statement-breakpoint
-- Machine callers retain their own principal; they do not impersonate a member.
-- The web role still cannot read canonical foreign accounts or connections.
CREATE OR REPLACE FUNCTION public.resolve_exposed_post_accounts(
  target_workspace_id uuid, account_ids uuid[], reserve boolean
) RETURNS TABLE (
  id uuid, destination_provider text, disconnected_at timestamptz,
  connection_status text, x_long_posts_allowed boolean, provider text,
  scopes jsonb, access_expires_at timestamptz, expires_at timestamptz,
  adapter_defaults jsonb, availability text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  machine_type text := nullif(current_setting('app.machine_actor_type', true), '');
  machine_id uuid := nullif(current_setting('app.machine_actor_id', true), '')::uuid;
  machine_capability text := nullif(current_setting('app.machine_capability', true), '');
  origin_id uuid;
BEGIN
  IF target_workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    OR account_ids IS NULL OR cardinality(account_ids) < 1
    OR cardinality(account_ids) > 100 OR EXISTS (
      SELECT 1 FROM unnest(account_ids) requested WHERE requested IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.workspaces workspace
      WHERE workspace.id = target_workspace_id AND workspace.deleted_at IS NULL
        AND (
          (machine_type IS NULL AND actor_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.memberships membership
            WHERE membership.workspace_id = target_workspace_id AND membership.user_id = actor_id
          ))
          OR (actor_id IS NULL AND machine_type = 'api-key'
            AND machine_capability IN ('schedules:read', 'schedules:write', 'content:write') AND EXISTS (
              SELECT 1 FROM public.api_keys key
              WHERE key.id = machine_id AND key.workspace_id = target_workspace_id
                AND key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at > now())
                AND machine_capability = ANY(key.capabilities)
          ))
          OR (actor_id IS NULL AND machine_type = 'delegated'
            AND machine_capability IN ('schedules:read', 'schedules:write', 'content:write') AND EXISTS (
              SELECT 1 FROM public.delegated_grants grant_record
              WHERE grant_record.id = machine_id AND grant_record.workspace_id = target_workspace_id
                AND grant_record.revoked_at IS NULL
                AND machine_capability = ANY(grant_record.scopes)
          ))
        )
    ) THEN
    RETURN;
  END IF;

  IF reserve THEN
    -- Match exposure edits and grant revokes: origin workspace, then target.
    FOR origin_id IN
      SELECT DISTINCT account.workspace_id FROM public.provider_accounts account
      WHERE account.id = ANY(account_ids) AND account.workspace_id <> target_workspace_id
      ORDER BY account.workspace_id
    LOOP
      PERFORM 1 FROM public.workspaces WHERE workspaces.id = origin_id FOR UPDATE;
    END LOOP;
    PERFORM 1 FROM public.workspaces WHERE workspaces.id = target_workspace_id FOR UPDATE;
  END IF;

  RETURN QUERY
  SELECT account.id, account.destination_provider, account.disconnected_at,
    connection.status,
    account.workspace_id = target_workspace_id AND account.x_long_posts_allowed,
    connection.provider,
    CASE WHEN account.workspace_id = target_workspace_id
      THEN connection.scopes ELSE '[]'::jsonb END,
    CASE WHEN account.workspace_id = target_workspace_id
      THEN connection.access_expires_at ELSE NULL END,
    CASE WHEN account.workspace_id = target_workspace_id
      THEN connection.expires_at ELSE NULL END,
    CASE WHEN account.workspace_id = target_workspace_id
      THEN account.adapter_defaults ELSE '{}'::jsonb END,
    account.availability
  FROM public.provider_accounts account
  JOIN public.provider_account_exposures exposure
    ON exposure.provider_account_id = account.id
    AND exposure.workspace_id = target_workspace_id AND exposure.revoked_at IS NULL
  JOIN public.provider_connections connection
    ON connection.id = account.connection_id AND connection.workspace_id = account.workspace_id
  WHERE account.id = ANY(account_ids)
    AND (account.workspace_id = target_workspace_id
      OR account.destination_provider = 'facebook_page');
END
$$;

REVOKE ALL ON FUNCTION public.resolve_exposed_post_accounts(uuid, uuid[], boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_exposed_post_accounts(uuid, uuid[], boolean)
      TO publish_relay_web;
  END IF;
END
$$;
