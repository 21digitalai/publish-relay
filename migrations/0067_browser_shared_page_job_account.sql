-- Resolve only the account identity attached to a job in the current workspace.
-- A revoked grant retains historical target-owned jobs, but never grants a new write.
CREATE FUNCTION public.resolve_browser_job_account(target_workspace_id uuid, requested_job_id uuid)
RETURNS TABLE (
  id uuid, display_name text, handle text, provider text, origin_workspace_name text
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT account.id, account.display_name,
    CASE WHEN account.workspace_id = target_workspace_id THEN account.provider_account_id
      ELSE NULL END,
    connection.provider,
    CASE WHEN account.workspace_id <> target_workspace_id THEN origin.name ELSE NULL END
  FROM public.publication_jobs job
  JOIN public.provider_accounts account ON account.id = job.provider_account_id
  JOIN public.provider_connections connection
    ON connection.id = account.connection_id AND connection.workspace_id = account.workspace_id
  JOIN public.workspaces origin ON origin.id = account.workspace_id
  LEFT JOIN public.provider_account_exposures exposure
    ON exposure.workspace_id = target_workspace_id AND exposure.provider_account_id = account.id
  WHERE target_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND job.workspace_id = target_workspace_id AND job.id = requested_job_id
    AND (
      account.workspace_id = target_workspace_id OR (
        account.destination_provider = 'facebook_page'
        AND exposure.provider_account_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.memberships member
          WHERE member.workspace_id = target_workspace_id
            AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        )
      )
    )
$$;

REVOKE ALL ON FUNCTION public.resolve_browser_job_account(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_browser_job_account(uuid, uuid)
      TO publish_relay_web;
  END IF;
END
$$;
