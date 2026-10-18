-- Machine job reads use the same authenticated principal/capability as admission.
CREATE OR REPLACE FUNCTION public.resolve_browser_job_account(target_workspace_id uuid, requested_job_id uuid)
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
        AND (
          EXISTS (
            SELECT 1 FROM public.memberships member
            WHERE member.workspace_id = target_workspace_id
              AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          )
          OR (
            nullif(current_setting('app.user_id', true), '') IS NULL
            AND nullif(current_setting('app.machine_capability', true), '') = 'schedules:read'
            AND (
              (nullif(current_setting('app.machine_actor_type', true), '') = 'api-key'
                AND EXISTS (
                  SELECT 1 FROM public.api_keys key
                  WHERE key.id = nullif(current_setting('app.machine_actor_id', true), '')::uuid
                    AND key.workspace_id = target_workspace_id AND key.revoked_at IS NULL
                    AND (key.expires_at IS NULL OR key.expires_at > now())
                    AND 'schedules:read' = ANY(key.capabilities)
                ))
              OR (nullif(current_setting('app.machine_actor_type', true), '') = 'delegated'
                AND EXISTS (
                  SELECT 1 FROM public.delegated_grants grant_record
                  WHERE grant_record.id = nullif(current_setting('app.machine_actor_id', true), '')::uuid
                    AND grant_record.workspace_id = target_workspace_id
                    AND grant_record.revoked_at IS NULL
                    AND 'schedules:read' = ANY(grant_record.scopes)
                ))
            )
          )
        )
      )
    )
$$;
