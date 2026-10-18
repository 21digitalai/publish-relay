-- Browser account discovery only: no credential, grant scope, or origin IDs.
CREATE FUNCTION public.list_visible_exposed_facebook_pages(target_workspace_id uuid)
RETURNS TABLE (
  id uuid, display_name text, origin_workspace_name text,
  availability text, connection_status text, updated_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT account.id, account.display_name, origin.name,
    account.availability, connection.status, account.updated_at
  FROM public.provider_account_exposures exposure
  JOIN public.provider_accounts account ON account.id = exposure.provider_account_id
  JOIN public.provider_connections connection
    ON connection.id = account.connection_id AND connection.workspace_id = account.workspace_id
  JOIN public.workspaces origin ON origin.id = account.workspace_id
  WHERE target_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND nullif(current_setting('app.user_id', true), '')::uuid IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.memberships member
      WHERE member.workspace_id = target_workspace_id
        AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    AND exposure.workspace_id = target_workspace_id AND exposure.revoked_at IS NULL
    AND account.workspace_id <> target_workspace_id
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL AND origin.deleted_at IS NULL
  ORDER BY account.display_name, account.id
$$;

REVOKE ALL ON FUNCTION public.list_visible_exposed_facebook_pages(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages(uuid)
      TO publish_relay_web;
  END IF;
END
$$;
