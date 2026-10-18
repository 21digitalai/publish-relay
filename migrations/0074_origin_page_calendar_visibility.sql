-- The canonical Page has a self-exposure row. Its owner controls the same
-- display-only preference as owners of actively exposed target workspaces.
CREATE OR REPLACE FUNCTION public.set_exposed_page_calendar_visibility(
  target_workspace_id uuid, account_id uuid, show_posts boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF target_workspace_id <> nullif(current_setting('app.workspace_id', true), '')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.memberships member
      WHERE member.workspace_id = target_workspace_id
        AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND member.role = 'owner') THEN
    RETURN false;
  END IF;

  UPDATE public.provider_account_exposures exposure
  SET show_other_workspace_posts = show_posts
  FROM public.provider_accounts account
  WHERE exposure.workspace_id = target_workspace_id
    AND exposure.provider_account_id = account_id
    AND exposure.provider_account_id = account.id
    AND exposure.revoked_at IS NULL
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL;
  RETURN FOUND;
END
$$;
