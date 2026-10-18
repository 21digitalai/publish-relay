-- Reuse the browser page projection, but admit a current scoped machine principal.
CREATE OR REPLACE FUNCTION public.list_visible_exposed_facebook_pages_page(
  target_workspace_id uuid, after_name text, after_id uuid, page_size integer
)
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
    AND EXISTS (
      SELECT 1 FROM public.workspaces target
      WHERE target.id = target_workspace_id AND target.deleted_at IS NULL
    )
    AND (
      (nullif(current_setting('app.machine_actor_type', true), '') IS NULL
        AND EXISTS (
          SELECT 1 FROM public.memberships member
          WHERE member.workspace_id = target_workspace_id
            AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        ))
      OR (nullif(current_setting('app.user_id', true), '') IS NULL
        AND nullif(current_setting('app.machine_capability', true), '') = 'destinations:read'
        AND (
          (nullif(current_setting('app.machine_actor_type', true), '') = 'api-key'
            AND EXISTS (
              SELECT 1 FROM public.api_keys key
              WHERE key.id = nullif(current_setting('app.machine_actor_id', true), '')::uuid
                AND key.workspace_id = target_workspace_id AND key.revoked_at IS NULL
                AND (key.expires_at IS NULL OR key.expires_at > now())
                AND 'destinations:read' = ANY(key.capabilities)
            ))
          OR (nullif(current_setting('app.machine_actor_type', true), '') = 'delegated'
            AND EXISTS (
              SELECT 1 FROM public.delegated_grants grant_record
              WHERE grant_record.id = nullif(current_setting('app.machine_actor_id', true), '')::uuid
                AND grant_record.workspace_id = target_workspace_id
                AND grant_record.revoked_at IS NULL
                AND 'destinations:read' = ANY(grant_record.scopes)
            ))
        ))
    )
    AND exposure.workspace_id = target_workspace_id AND exposure.revoked_at IS NULL
    AND account.workspace_id <> target_workspace_id
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL
    AND (nullif(current_setting('app.machine_actor_type', true), '') IS NULL
      OR connection.status = 'active')
    AND origin.deleted_at IS NULL
    AND (after_name IS NULL OR (account.display_name, account.id) > (after_name, after_id))
  ORDER BY account.display_name, account.id
  LIMIT LEAST(GREATEST(page_size, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer)
      TO publish_relay_web;
  END IF;
END
$$;
