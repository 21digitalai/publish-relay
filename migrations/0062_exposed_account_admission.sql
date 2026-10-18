-- Return only scheduling metadata for accounts actively exposed to the target.
-- The web role cannot read canonical accounts or connections in other workspaces.
CREATE FUNCTION public.resolve_exposed_post_accounts(
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
  origin_id uuid;
BEGIN
  IF target_workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    OR actor_id IS NULL OR account_ids IS NULL OR cardinality(account_ids) < 1
    OR cardinality(account_ids) > 100 OR EXISTS (
      SELECT 1 FROM unnest(account_ids) requested WHERE requested IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.memberships membership
      JOIN public.workspaces workspace ON workspace.id = membership.workspace_id
      WHERE membership.workspace_id = target_workspace_id AND membership.user_id = actor_id
        AND workspace.deleted_at IS NULL
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
