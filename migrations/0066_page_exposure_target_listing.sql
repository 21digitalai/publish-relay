-- Narrow origin-owner view of active target grants for checkbox state.
CREATE FUNCTION public.list_facebook_page_exposure_targets(
  origin_workspace_id uuid, account_id uuid, after_id uuid, page_size integer
) RETURNS TABLE (workspace_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT exposure.workspace_id
  FROM public.provider_account_exposures exposure
  JOIN public.provider_accounts account ON account.id = exposure.provider_account_id
  JOIN public.memberships origin_member
    ON origin_member.workspace_id = origin_workspace_id
      AND origin_member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND origin_member.role = 'owner'
  JOIN public.memberships target_member
    ON target_member.workspace_id = exposure.workspace_id
      AND target_member.user_id = origin_member.user_id
      AND target_member.role = 'owner'
  JOIN public.workspaces target ON target.id = exposure.workspace_id
  WHERE origin_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND account.id = account_id AND account.workspace_id = origin_workspace_id
    AND account.destination_provider = 'facebook_page' AND account.disconnected_at IS NULL
    AND exposure.revoked_at IS NULL AND exposure.workspace_id <> origin_workspace_id
    AND target.deleted_at IS NULL
    AND (after_id IS NULL OR exposure.workspace_id > after_id)
  ORDER BY exposure.workspace_id
  LIMIT LEAST(GREATEST(page_size, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.list_facebook_page_exposure_targets(uuid, uuid, uuid, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_facebook_page_exposure_targets(uuid, uuid, uuid, integer)
      TO publish_relay_web;
  END IF;
END
$$;
